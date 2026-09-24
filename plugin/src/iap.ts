// IAP signed-header verification for the hosted console (M3-SPEC §3).
//
// Every request to the hosted console carries `x-goog-iap-jwt-assertion`, which IAP signs
// with ES256. Google's documentation ("Securing your app with signed headers") requires:
// alg ES256 with a `kid` from the published key set, iss `https://cloud.google.com/iap`,
// aud the resource's audience (for Cloud Run
// `/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME`, from IAP_AUDIENCE, never
// hardcoded), exp in the future and iat in the past with at most 30 s of clock skew, and
// the user's identity from the `email` claim.
//
// The key set (https://www.gstatic.com/iap/verify/public_key-jwk) is cached for as long as
// its Cache-Control allows; concurrent refreshes share one fetch; a token whose kid is not
// in a fresh set triggers a refetch at most once every 5 minutes. A failed refresh keeps
// the previous set for a bounded time (it is public data Google rotates slowly) and retries
// after a short pause, so a transient outage of gstatic is not an outage of the console.

import { importJWK, jwtVerify, type JWK } from 'jose';

export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const IAP_JWK_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
export const IAP_HEADER = 'x-goog-iap-jwt-assertion';
export const CLOCK_SKEW_S = 30;
/** Minimum spacing of refetches caused by an unknown `kid`. */
export const UNKNOWN_KID_REFETCH_MS = 5 * 60_000;
/** Bounds on how long a fetched key set is trusted without revalidation. */
export const MIN_KEYS_TTL_MS = 60_000;
export const MAX_KEYS_TTL_MS = 24 * 60 * 60_000;
/** Without a usable Cache-Control max-age. */
export const DEFAULT_KEYS_TTL_MS = 5 * 60_000;
/** After a failed refresh: how long until the next attempt, and how long an old set lives on. */
export const FAILED_REFRESH_RETRY_MS = 30_000;
export const STALE_KEYS_GRACE_MS = 60 * 60_000;

const MAX_TOKEN_LENGTH = 8192;
const MAX_JWKS_BYTES = 64 * 1024;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}$/;
/** IAP's audience for a Cloud Run service, an App Engine app or a backend service. */
const AUDIENCE_RE = /^\/projects\/[0-9]{1,20}\/[A-Za-z0-9/._-]{1,256}$/;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** The verifying key for an ES256 `kid`, or null when the set does not have it. */
type VerifyKey = Awaited<ReturnType<typeof importJWK>>;

/** max-age (less Age) from Cache-Control, clamped; the default when absent or unusable. */
export function keysTtlMs(cacheControl: string | null, age: string | null): number {
  let ttl = DEFAULT_KEYS_TTL_MS;
  if (cacheControl) {
    const directives = cacheControl.toLowerCase().split(',').map((d) => d.trim());
    if (directives.includes('no-store') || directives.includes('no-cache')) {
      ttl = MIN_KEYS_TTL_MS;
    } else {
      const m = directives.map((d) => /^max-age=(\d{1,10})$/.exec(d)).find((x) => x !== null);
      if (m) {
        const ageS = age && /^\d{1,10}$/.test(age.trim()) ? Number(age.trim()) : 0;
        ttl = (Number(m[1]) - ageS) * 1000;
      }
    }
  }
  return Math.min(MAX_KEYS_TTL_MS, Math.max(MIN_KEYS_TTL_MS, ttl));
}

export type IapKeySetOptions = {
  url?: string;
  fetch?: Fetcher;
  now?: () => number;
  timeoutMs?: number;
  log?: (line: string) => void;
};

/** Google's IAP public keys, cached per Cache-Control with single-flight refresh. */
export class IapKeySet {
  private readonly url: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private keys = new Map<string, VerifyKey>();
  /** Until when `keys` is fresh; 0 before the first fetch. */
  private freshUntil = 0;
  /** Until when `keys` may still be used after failed refreshes. */
  private usableUntil = 0;
  /** When the last fetch (successful or not) started. */
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;
  /** Fetches made, for tests and the log. */
  fetches = 0;

  constructor(opts: IapKeySetOptions = {}) {
    this.url = opts.url ?? IAP_JWK_URL;
    this.fetcher = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.log = opts.log ?? (() => {});
  }

  private async load(): Promise<void> {
    this.fetches++;
    this.lastFetchAt = this.now();
    let res: Response;
    try {
      res = await this.fetcher(this.url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error('IAP key set unreachable');
    }
    if (!res.ok) throw new Error(`IAP key set answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_JWKS_BYTES) throw new Error('IAP key set too large');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('IAP key set is not JSON');
    }
    const list = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(list)) throw new Error('IAP key set has no keys');
    const next = new Map<string, VerifyKey>();
    for (const jwk of list as unknown[]) {
      if (!jwk || typeof jwk !== 'object') continue;
      const k = jwk as JWK & { kid?: unknown; use?: unknown };
      // ES256 only: an EC P-256 signing key. Anything else in the set is ignored.
      if (typeof k.kid !== 'string' || !k.kid || k.kty !== 'EC' || k.crv !== 'P-256') continue;
      if (k.alg !== undefined && k.alg !== 'ES256') continue;
      if (k.use !== undefined && k.use !== 'sig') continue;
      if ('d' in k) continue; // never a private key
      try {
        next.set(k.kid, await importJWK({ kty: 'EC', crv: 'P-256', x: k.x, y: k.y }, 'ES256'));
      } catch {
        // an unusable key is skipped
      }
    }
    if (next.size === 0) throw new Error('IAP key set has no ES256 keys');
    const ttl = keysTtlMs(res.headers.get('cache-control'), res.headers.get('age'));
    this.keys = next;
    this.freshUntil = this.now() + ttl;
    this.usableUntil = this.freshUntil + STALE_KEYS_GRACE_MS;
  }

  /** One refresh at a time; every caller waits for the same one. */
  private refresh(): Promise<void> {
    this.inflight ??= this.load()
      .catch((err: unknown) => {
        this.log(`iap: key refresh failed (${err instanceof Error ? err.message : 'error'})`);
        // Keep the previous set while it is usable (key() checks usableUntil); try again
        // after a pause, not on every request.
        this.freshUntil = this.now() + FAILED_REFRESH_RETRY_MS;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** The key for `kid`, refreshing the set when it is stale or (rate-limited) when kid is unknown. */
  async key(kid: string): Promise<VerifyKey | null> {
    if (this.now() >= this.freshUntil) {
      await this.refresh();
    } else if (!this.keys.has(kid) && this.now() - this.lastFetchAt >= UNKNOWN_KID_REFETCH_MS) {
      await this.refresh();
    }
    if (this.now() >= this.usableUntil) return null;
    return this.keys.get(kid) ?? null;
  }
}

export type IapVerifierOptions = {
  audience: string;
  keys: IapKeySet;
  now?: () => number;
  log?: (line: string) => void;
};

export type IapIdentity = { email: string };

/** Checks an IAP audience value from the environment. */
export function checkIapAudience(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) throw new Error('IAP_AUDIENCE must be set');
  if (!AUDIENCE_RE.test(v) || v.includes('//') || v.split('/').includes('..')) {
    throw new Error('IAP_AUDIENCE must look like /projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME');
  }
  return v;
}

/**
 * Verifies an IAP assertion; resolves with the lower-cased email, or null for anything that
 * is not a valid, current assertion for this audience. The reason goes to the log only
 * (never the token, never the claims).
 */
export function iapVerifier(opts: IapVerifierOptions): (assertion: string | undefined) => Promise<IapIdentity | null> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const audience = opts.audience;
  const reject = (why: string) => {
    log(`iap: refused (${why})`);
    return null;
  };

  return async (assertion) => {
    if (assertion === undefined || assertion === '') return reject('no assertion');
    if (assertion.length > MAX_TOKEN_LENGTH || !JWT_SHAPE.test(assertion)) return reject('malformed');
    let header: { alg?: unknown; kid?: unknown };
    try {
      header = JSON.parse(Buffer.from(assertion.split('.')[0]!, 'base64url').toString('utf8')) as typeof header;
    } catch {
      return reject('malformed header');
    }
    if (!header || typeof header !== 'object') return reject('malformed header');
    if (header.alg !== 'ES256') return reject('algorithm');
    if (typeof header.kid !== 'string' || header.kid === '' || header.kid.length > 256) return reject('no kid');
    const key = await opts.keys.key(header.kid);
    if (!key) return reject('unknown kid');

    const nowS = Math.floor(now() / 1000);
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(assertion, key, {
        algorithms: ['ES256'],
        issuer: IAP_ISSUER,
        audience,
        clockTolerance: CLOCK_SKEW_S,
        requiredClaims: ['exp', 'iat', 'email'],
        currentDate: new Date(nowS * 1000),
      }));
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return reject(typeof code === 'string' ? code : 'invalid');
    }
    // What jose does not check on its own: a single audience, and iat not in the future.
    if (payload.aud !== audience) return reject('audience');
    const { iat, exp, email } = payload;
    if (typeof iat !== 'number' || !Number.isFinite(iat) || iat > nowS + CLOCK_SKEW_S) return reject('iat');
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowS - CLOCK_SKEW_S) return reject('exp');
    if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) return reject('email');
    return { email: email.toLowerCase() };
  };
}
