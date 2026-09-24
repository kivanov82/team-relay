// The console's HTTP server (M2-SPEC §4.4; hosted mode M3-SPEC §3), as a factory the entry
// script and the tests share.
//
// Local mode (bin/console):
// - Loopback only; any request whose Host is not 127.0.0.1:<port> or localhost:<port> is
//   refused (DNS rebinding).
// - /api/* needs X-Console-Key equal to the per-launch key (compared in constant time):
//   missing is 401, wrong is 403. No CORS headers, ever; a cross-site fetch is refused.
// - A read-only proxy of exactly six GETs: /api/me, /api/directory, /api/activity,
//   /api/requests/{id}, /api/roster (M6-SPEC §3) and /api/inbox/summary (M7-SPEC §3). The only writes are the owner's roster
//   changes: POST /api/roster, PATCH and DELETE /api/roster/{member}, each with
//   Content-Type: application/json and Sec-Fetch-Site: same-origin, and a body checked here
//   before it is sent on. Nothing else is proxied, so there is no way to send, ack or reply
//   from the console.
// - GET /api/join, answered by the console server itself (never proxied): what a new member
//   needs to install the plugin (relay URL, team, the repository to clone, marketplace and
//   plugin names). Nothing secret; the same gate as the other /api routes. Hosted, it is
//   answered only to a member of the team (M6-SPEC §7 item 6; below).
// - Static files from dist/console/ under a strict CSP; a placeholder page when it is absent.
//
// Hosted mode (the container, CONSOLE_MODE=hosted, behind IAP):
// - Binds 0.0.0.0; the Host must equal the service's public host exactly.
// - No console key: every request, static files included, must carry a valid IAP assertion
//   (x-goog-iap-jwt-assertion); anything else is a bare 401. The viewer's email from it is
//   sent to the relay as X-Relay-On-Behalf-Of on each of the same routes. A viewer on no
//   roster of the team (the relay's 403 not_a_member; M6-SPEC §4: any signed-in Google
//   account reaches the page) gets 403 {"error": "not_on_team", "email"} and no data. That
//   includes /api/join: the relay is asked who the viewer is (/me) first, and only a member
//   of the team gets the join details (M6-SPEC §7 item 6).

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, sep } from 'node:path';
import { BadRequest, NotFound, RosterRefusal, type DemoTeam } from './console-demo.js';
import { IAP_HEADER, type IapIdentity } from './iap.js';
import {
  MEMBER_RE,
  REQUEST_ID_RE,
  RelayError,
  RelayNetworkError,
  type AddMemberBody,
  type RelayClient,
  type RosterRole,
  type UpdateMemberBody,
} from './relay-client.js';
import { normaliseRelayUrl } from './credentials.js';
import { defaultRelayUrl } from './relay-default.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Who a read is for: in hosted mode, the viewer IAP signed in. */
export type ReadContext = { viewer?: string };

/** What the proxy reads. Each call answers with the relay's JSON. */
export type ConsoleBackend = {
  me(ctx?: ReadContext): Promise<unknown>;
  directory(ctx?: ReadContext): Promise<unknown>;
  activity(q: { since?: string; limit?: number }, ctx?: ReadContext): Promise<unknown>;
  request(id: string, ctx?: ReadContext): Promise<unknown>;
  /** M6-SPEC §2, §3: the roster, and the owner's changes to it. */
  roster(ctx?: ReadContext): Promise<unknown>;
  /** M7-SPEC §1, §3: what waits for the viewer's answering session. */
  inboxSummary(ctx?: ReadContext): Promise<unknown>;
  addMember(body: AddMemberBody, ctx?: ReadContext): Promise<unknown>;
  updateMember(member: string, body: UpdateMemberBody, ctx?: ReadContext): Promise<unknown>;
  removeMember(member: string, ctx?: ReadContext): Promise<unknown>;
};

export function relayBackend(client: RelayClient): ConsoleBackend {
  const opts = (ctx?: ReadContext) => ({
    attempts: 1,
    timeoutMs: 15_000,
    ...(ctx?.viewer !== undefined ? { onBehalfOf: ctx.viewer } : {}),
  });
  return {
    me: (ctx) => client.me(opts(ctx)),
    directory: (ctx) => client.directory(opts(ctx)),
    activity: (q, ctx) => client.activity(q, opts(ctx)),
    request: (id, ctx) => client.getRequest(id, opts(ctx)),
    roster: (ctx) => client.roster(opts(ctx)),
    inboxSummary: (ctx) => client.inboxSummary(opts(ctx)),
    addMember: (body, ctx) => client.addMember(body, opts(ctx)),
    updateMember: (member, body, ctx) => client.updateMember(member, body, opts(ctx)),
    removeMember: (member, ctx) => client.removeMember(member, opts(ctx)),
  };
}

export function demoBackend(team: DemoTeam): ConsoleBackend {
  return {
    me: async () => team.me(),
    directory: async () => team.directory(),
    activity: async (q) => team.activity(q),
    request: async (id) => team.request(id),
    roster: async () => team.roster(),
    inboxSummary: async () => team.inboxSummary(),
    addMember: async (body) => team.addMember(body),
    updateMember: async (member, body) => team.updateMember(member, body),
    removeMember: async (member) => team.removeMember(member),
  };
}

// ---------------------------------------------------------------------------------------
// The roster bodies (M6-SPEC §2), checked before anything reaches the relay.

/** A lower-cased Google email address, as the roster stores it. */
export const ROSTER_EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;
const ROLES: readonly RosterRole[] = ['owner', 'member'];
/** The largest body a roster change may have. */
export const ROSTER_BODY_LIMIT = 4096;

export class BodyError extends Error {}

function onlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new BodyError(`unknown field ${k.slice(0, 40)}`);
}

function email(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new BodyError(`${field} must be an email address`);
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !ROSTER_EMAIL_RE.test(e)) throw new BodyError(`${field} must be an email address`);
  return e;
}

function role(v: unknown): RosterRole {
  if (typeof v !== 'string' || !ROLES.includes(v as RosterRole)) throw new BodyError('role must be "owner" or "member"');
  return v as RosterRole;
}

export function checkAddMember(raw: unknown): AddMemberBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BodyError('the body must be a JSON object');
  const b = raw as Record<string, unknown>;
  onlyKeys(b, ['member', 'email', 'role']);
  if (typeof b.member !== 'string' || !MEMBER_RE.test(b.member)) {
    throw new BodyError('member must be 2 to 32 characters: a lower-case letter, then lower-case letters, digits or _');
  }
  const out: AddMemberBody = { member: b.member, email: email(b.email, 'email') };
  if (b.role !== undefined) out.role = role(b.role);
  return out;
}

export function checkUpdateMember(raw: unknown): UpdateMemberBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BodyError('the body must be a JSON object');
  const b = raw as Record<string, unknown>;
  onlyKeys(b, ['add_email', 'remove_email', 'role']);
  const out: UpdateMemberBody = {};
  if (b.add_email !== undefined) out.add_email = email(b.add_email, 'add_email');
  if (b.remove_email !== undefined) out.remove_email = email(b.remove_email, 'remove_email');
  if (b.role !== undefined) out.role = role(b.role);
  if (Object.keys(out).length === 0) throw new BodyError('nothing to change: give add_email, remove_email or role');
  return out;
}

/** GET /api/join: how to join the team, for the console's join panel. Nothing secret. */
export type JoinInfo = {
  relay_url: string;
  team: string;
  /** The team-relay repository (JOIN_REPO_URL), or null. */
  repo_url: string | null;
  /**
   * What `/plugin marketplace add` takes (M5-SPEC §1): JOIN_MARKETPLACE (GitHub owner/repo,
   * or an https git URL), else derived from JOIN_REPO_URL, else null (ask the team owner).
   */
  marketplace_source: string | null;
  marketplace: string;
  plugin: string;
  /** True when relay_url is the plugin's own default, so a bare /team-relay:login reaches it. */
  default_relay: boolean;
};

/** The marketplace at the repository root (.claude-plugin/marketplace.json) and its plugin. */
export const JOIN_MARKETPLACE = 'team-relay-dev';
export const JOIN_PLUGIN = 'team-relay';

const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** JOIN_MARKETPLACE: GitHub owner/repo or a plain https URL; unset or empty is null. */
export function checkJoinMarketplace(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (GITHUB_REPO_RE.test(v) && !v.split('/').some((x) => x === '.' || x === '..')) return v;
  try {
    return checkJoinRepoUrl(v);
  } catch {
    throw new Error('JOIN_MARKETPLACE must be a GitHub owner/repo or a plain https URL');
  }
}

/** A GitHub repository URL becomes owner/repo; any other URL stays as it is. */
export function marketplaceFromRepoUrl(repoUrl: string | null): string | null {
  if (!repoUrl) return null;
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(repoUrl);
  return m ? `${m[1]}/${m[2]}` : repoUrl;
}

export function joinInfo(
  relayUrl: string,
  team: string,
  repoUrl: string | null,
  marketplaceSource: string | null = null,
  defaultRelay: string | null = defaultRelayUrl(),
): JoinInfo {
  let isDefault = false;
  try {
    isDefault = defaultRelay !== null && normaliseRelayUrl(relayUrl) === normaliseRelayUrl(defaultRelay);
  } catch {
    isDefault = false;
  }
  return {
    relay_url: relayUrl,
    team,
    repo_url: repoUrl,
    marketplace_source: marketplaceSource ?? marketplaceFromRepoUrl(repoUrl),
    marketplace: JOIN_MARKETPLACE,
    plugin: JOIN_PLUGIN,
    default_relay: isDefault,
  };
}

/** --demo: nothing real, and no repository. */
export const DEMO_JOIN: JoinInfo = joinInfo('https://relay.example.com', 'demo', null, 'example/team-relay', null);

/**
 * JOIN_REPO_URL: an https URL with a host and an optional plain path, nothing a shell would
 * read as more than one word (it is shown in a command to copy), no credentials, query or
 * fragment. Unset or empty is null.
 */
const REPO_URL_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?(\/[A-Za-z0-9._~%+-]+)*\/?$/i;

export function checkJoinRepoUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error('JOIN_REPO_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('JOIN_REPO_URL must be an https URL');
  if (url.username || url.password) throw new Error('JOIN_REPO_URL must not carry credentials');
  if (url.search || url.hash || v.includes('?') || v.includes('#')) throw new Error('JOIN_REPO_URL must not carry a query or fragment');
  if (v.length > 512 || !REPO_URL_RE.test(v) || v.split('/').slice(3).some((seg) => seg === '.' || seg === '..')) {
    throw new Error('JOIN_REPO_URL must be a plain https URL: a host and a path of letters, digits and ._~%+-');
  }
  return v;
}

const PLACEHOLDER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Team relay console</title></head>
<body>
<h1>Team relay console</h1>
<p>The console has not been built yet: <code>dist/console/</code> is missing. Build it from
<code>console/</code> (it builds into <code>plugin/dist/console/</code>), then reload this page.</p>
<p>The API is running: <code>/api/me</code>, <code>/api/directory</code>, <code>/api/activity</code>,
<code>/api/requests/{id}</code>, <code>/api/roster</code>, <code>/api/inbox/summary</code> and <code>/api/join</code>, with the key from this page's
address in an <code>X-Console-Key</code> header.</p>
</body>
</html>
`;

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time comparison: both sides are hashed first, so lengths never leak or throw. */
export function keyMatches(given: string, key: string): boolean {
  return timingSafeEqual(digest(given), digest(key));
}

export type HostedOptions = {
  /** The service's public host (CONSOLE_PUBLIC_HOST); the Host header must equal it. */
  publicHost: string;
  /** Verifies the IAP assertion: the viewer, or null to refuse. */
  verify: (assertion: string | undefined) => Promise<IapIdentity | null>;
};

export type ConsoleServerOptions = {
  backend: ConsoleBackend;
  /** dist/console/ (the built UI). */
  staticDir: string;
  /** What GET /api/join answers; without it, /api/join is 404. */
  join?: JoinInfo;
  log?: (line: string) => void;
} & (
  | { /** Local mode: the per-launch key. */ key: string; hosted?: undefined }
  | { key?: undefined; /** Hosted mode (M3-SPEC §3). */ hosted: HostedOptions }
);

export type ConsoleServer = {
  server: Server;
  /**
   * Bind `port` (0 picks a free one) on 127.0.0.1 locally, 0.0.0.0 hosted; resolves with the
   * bound port.
   */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
};

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/;

/** CONSOLE_PUBLIC_HOST: a lower-case host name (a port only if it is part of the public host). */
export function checkPublicHost(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) throw new Error('CONSOLE_PUBLIC_HOST must be set');
  if (v.length > 253 || !HOST_RE.test(v)) throw new Error('CONSOLE_PUBLIC_HOST must be a lower-case host name, without a scheme or path');
  return v;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}, head = false) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(buf.length), ...extra });
  res.end(head ? undefined : buf);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });
}

/** The request body, at most `limit` bytes (else it rejects, and the rest is discarded). */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(new Error('too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? undefined : v;
}

export function createConsoleServer(opts: ConsoleServerOptions): ConsoleServer {
  const log = opts.log ?? (() => {});
  const hosted = opts.hosted ?? null;
  if (hosted) checkPublicHost(hosted.publicHost);
  else if (typeof opts.key !== 'string' || opts.key === '') throw new Error('a console key is required in local mode');
  let port = -1;
  let staticRoot: string | null = null;
  try {
    if (statSync(opts.staticDir).isDirectory()) staticRoot = realpathSync(opts.staticDir);
  } catch {
    staticRoot = null;
  }

  function hostAllowed(req: IncomingMessage): boolean {
    const host = headerValue(req, 'host')?.toLowerCase();
    if (hosted) return host === hosted.publicHost;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  /** A relay (or demo) failure as the console answers it. */
  function failure(res: ServerResponse, err: unknown, viewer: string | undefined): void {
    // M6-SPEC §4: hosted, a signed-in account on no roster of this team (the relay's 403
    // not_a_member for the delegate's on-behalf-of) gets no data, only this. A plain 401 is
    // the console's own sign-in to the relay failing: a misconfiguration, passed on as such.
    if (hosted && viewer !== undefined && err instanceof RelayError && err.status === 403 && err.code === 'not_a_member') {
      return sendJson(res, 403, { error: 'not_on_team', email: viewer });
    }
    if (err instanceof NotFound || (err instanceof RelayError && err.status === 404)) return sendJson(res, 404, { error: 'not_found' });
    if (err instanceof BadRequest) return sendJson(res, 400, { error: 'bad_request', detail: err.detail });
    if (err instanceof RosterRefusal) {
      return sendJson(res, 502, { error: 'relay_refused', relay_status: err.status, relay_error: err.code, detail: err.detail });
    }
    if (err instanceof RelayError) {
      return sendJson(res, 502, {
        error: 'relay_refused',
        relay_status: err.status,
        relay_error: err.code,
        ...(err.detail ? { detail: err.detail.slice(0, 300) } : {}),
      });
    }
    if (err instanceof RelayNetworkError) return sendJson(res, 502, { error: 'relay_unreachable', detail: err.message });
    // Credentials (gcloud, the credential file) or anything else: the message never carries a token.
    const detail = err instanceof Error ? err.message.slice(0, 300) : 'unexpected error';
    return sendJson(res, 502, { error: 'relay_unavailable', detail });
  }

  /** M6-SPEC §3: POST /api/roster, PATCH and DELETE /api/roster/{member}. */
  async function rosterChange(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ReadContext, viewer: string | undefined): Promise<void> {
    const path = url.pathname;
    const one = /^\/api\/roster\/([^/]+)$/.exec(path);
    const allowed = one ? ['PATCH', 'DELETE'] : ['POST'];
    const method = req.method ?? '';
    if (!allowed.includes(method)) {
      req.resume();
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: ['GET', ...allowed].filter((m) => !(one && m === 'GET')).join(', ') });
    }
    // A change is made only from the console's own page.
    if (headerValue(req, 'sec-fetch-site') !== 'same-origin') {
      req.resume();
      return sendJson(res, 403, { error: 'forbidden', detail: 'Sec-Fetch-Site: same-origin is required' });
    }
    const type = headerValue(req, 'content-type') ?? '';
    if (!/^application\/json\s*(;.*)?$/i.test(type)) {
      req.resume();
      return sendJson(res, 415, { error: 'unsupported_media_type', detail: 'Content-Type must be application/json' });
    }
    if ([...url.searchParams.keys()].length > 0) {
      req.resume();
      return sendJson(res, 400, { error: 'bad_request', detail: 'no query parameters here' });
    }
    const member = one ? one[1]! : null;
    if (member !== null && !MEMBER_RE.test(member)) {
      req.resume();
      return sendJson(res, 404, { error: 'not_found' });
    }
    let text: string;
    try {
      text = await readBody(req, ROSTER_BODY_LIMIT);
    } catch {
      return sendJson(res, 413, { error: 'too_large', detail: `at most ${ROSTER_BODY_LIMIT} bytes` });
    }
    let raw: unknown = undefined;
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return sendJson(res, 400, { error: 'bad_request', detail: 'the body is not JSON' });
      }
    }
    let call: () => Promise<unknown>;
    try {
      if (method === 'POST') {
        const body = checkAddMember(raw);
        call = () => opts.backend.addMember(body, ctx);
      } else if (method === 'PATCH') {
        const body = checkUpdateMember(raw);
        call = () => opts.backend.updateMember(member!, body, ctx);
      } else {
        if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0)) {
          throw new BodyError('a removal takes no body');
        }
        call = () => opts.backend.removeMember(member!, ctx);
      }
    } catch (err) {
      return sendJson(res, 400, { error: 'bad_request', detail: err instanceof BodyError ? err.message : 'bad body' });
    }
    log(`roster ${method === 'POST' ? 'add' : method === 'PATCH' ? 'update' : 'remove'}${member ? ` ${member}` : ''}`);
    try {
      return sendJson(res, method === 'POST' ? 201 : 200, await call());
    } catch (err) {
      return failure(res, err, viewer);
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, viewer: string | undefined): Promise<void> {
    // A page on another site cannot read these (no CORS), and is refused outright when the
    // browser says the request is cross-site.
    const site = headerValue(req, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      req.resume();
      return sendJson(res, 403, { error: 'forbidden', detail: 'cross-site request' });
    }
    if (!hosted) {
      const given = headerValue(req, 'x-console-key');
      if (given === undefined || given === '') {
        req.resume();
        return sendJson(res, 401, { error: 'unauthenticated', detail: 'X-Console-Key is required' });
      }
      if (!keyMatches(given, opts.key!)) {
        req.resume();
        return sendJson(res, 403, { error: 'forbidden', detail: 'wrong console key' });
      }
    }
    const ctx: ReadContext = viewer !== undefined ? { viewer } : {};
    const path = url.pathname;
    const roster = path === '/api/roster' || /^\/api\/roster\/[^/]+$/.test(path);
    if (req.method !== 'GET') {
      if (roster) return rosterChange(req, res, url, ctx, viewer);
      req.resume();
      return sendJson(res, 405, { error: 'method_not_allowed', detail: 'the console is read-only' }, { Allow: 'GET' });
    }
    req.resume();

    const query = [...url.searchParams.keys()];
    if (path === '/api/join') {
      // Answered here, from the server's own configuration, never proxied.
      if (query.length > 0) return sendJson(res, 400, { error: 'bad_request', detail: 'no query parameters here' });
      if (hosted) {
        // M6-SPEC §7 item 6: hosted, only a signed-in member of the team gets the join details.
        // The relay is asked who the viewer is; anyone else gets the not-on-team response (the
        // relay's 403 not_a_member), as on every other route, and nothing about joining.
        try {
          await opts.backend.me(ctx);
        } catch (err) {
          return failure(res, err, viewer);
        }
      }
      if (!opts.join) return sendJson(res, 404, { error: 'not_found' });
      return sendJson(res, 200, opts.join);
    }
    let call: () => Promise<unknown>;
    if (path === '/api/me' || path === '/api/directory' || path === '/api/roster' || path === '/api/inbox/summary') {
      if (query.length > 0) return sendJson(res, 400, { error: 'bad_request', detail: 'no query parameters here' });
      // Hosted, the viewer's own IAP-verified email rides along on /api/me so the join panel can
      // fill in their commands; it is theirs, and nobody else's is ever added.
      call =
        path === '/api/me'
          ? async () => {
              const me = await opts.backend.me(ctx);
              return ctx.viewer !== undefined && me !== null && typeof me === 'object' && !Array.isArray(me)
                ? { ...(me as Record<string, unknown>), email: ctx.viewer }
                : me;
            }
          : path === '/api/directory'
            ? () => opts.backend.directory(ctx)
            : path === '/api/inbox/summary'
              ? () => opts.backend.inboxSummary(ctx)
              : () => opts.backend.roster(ctx);
    } else if (path === '/api/activity') {
      const q: { since?: string; limit?: number } = {};
      for (const k of query) {
        if (k !== 'since' && k !== 'limit') return sendJson(res, 400, { error: 'bad_request', detail: `unknown parameter ${k.slice(0, 40)}` });
      }
      if (url.searchParams.getAll('since').length > 1 || url.searchParams.getAll('limit').length > 1) {
        return sendJson(res, 400, { error: 'bad_request', detail: 'repeated parameter' });
      }
      const since = url.searchParams.get('since');
      if (since !== null) {
        if (!RFC3339.test(since)) return sendJson(res, 400, { error: 'bad_request', detail: 'since must be an RFC 3339 time' });
        q.since = since;
      }
      const limit = url.searchParams.get('limit');
      if (limit !== null) {
        if (!/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) {
          return sendJson(res, 400, { error: 'bad_request', detail: 'limit must be 1..200' });
        }
        q.limit = Number(limit);
      }
      call = () => opts.backend.activity(q, ctx);
    } else {
      const m = /^\/api\/requests\/([^/]+)$/.exec(path);
      if (!m || !REQUEST_ID_RE.test(m[1]!) || query.length > 0) return sendJson(res, 404, { error: 'not_found' });
      const id = m[1]!;
      call = () => opts.backend.request(id, ctx);
    }

    try {
      return sendJson(res, 200, await call());
    } catch (err) {
      return failure(res, err, viewer);
    }
  }

  function staticFile(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) return send(res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
    const html = (body: string | Buffer) => send(res, 200, body, MIME['.html']!, { 'Cache-Control': 'no-cache' }, head);
    const index = staticRoot ? join(staticRoot, 'index.html') : null;
    if (!staticRoot || !index || !existsSync(index)) return html(PLACEHOLDER);

    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, 'bad path\n', 'text/plain; charset=utf-8');
    }
    if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some((seg) => seg === '..' || seg === '.')) {
      return send(res, 400, 'bad path\n', 'text/plain; charset=utf-8');
    }
    if (rel === '/' || rel === '') return html(readFileSync(index));
    const candidate = join(staticRoot, rel);
    let real: string | null = null;
    try {
      real = realpathSync(candidate);
    } catch {
      real = null;
    }
    if (real && real.startsWith(staticRoot + sep) && statSync(real).isFile()) {
      const type = MIME[extname(real).toLowerCase()] ?? 'application/octet-stream';
      // Hashed assets never change under their name; everything else is revalidated.
      // Hosted, everything is behind sign-in, so no shared cache may keep it.
      const cache = rel.startsWith('/assets/') ? `${hosted ? 'private' : 'public'}, max-age=31536000, immutable` : 'no-cache';
      return send(res, 200, readFileSync(real), type, { 'Cache-Control': cache }, head);
    }
    // A client-side route (no file extension) gets the app; a missing asset is a 404.
    if (!extname(rel)) return html(readFileSync(index));
    return send(res, 404, 'not found\n', 'text/plain; charset=utf-8');
  }

  /** Hosted: a bare 401, no detail (the reason is logged by the verifier). */
  const unauthorized = (res: ServerResponse) =>
    send(res, 401, 'unauthorized\n', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });

  const server = createServer((req, res) => {
    // Only a roster change's body is ever read (rosterChange); any other is discarded.
    if (!hostAllowed(req)) {
      req.resume();
      send(res, 403, 'forbidden host\n', 'text/plain; charset=utf-8');
      return;
    }
    if (!hosted) {
      route(req, res, undefined);
      return;
    }
    const assertion = req.headers[IAP_HEADER];
    hosted.verify(Array.isArray(assertion) ? undefined : assertion).then(
      (identity) => {
        if (!identity) {
          req.resume();
          return unauthorized(res);
        }
        route(req, res, identity.email);
      },
      () => {
        log('iap: verification error');
        req.resume();
        if (!res.headersSent) unauthorized(res);
      },
    );
  });

  function route(req: IncomingMessage, res: ServerResponse, viewer: string | undefined): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      req.resume();
      send(res, 400, 'bad request\n', 'text/plain; charset=utf-8');
      return;
    }
    // Only origin-form paths that are already normal: nothing the URL parser had to resolve.
    const rawPath = (req.url ?? '').split('?')[0];
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (!isApi) req.resume();
    if (!rawPath?.startsWith('/') || rawPath !== url.pathname) {
      req.resume();
      send(res, 400, 'bad path\n', 'text/plain; charset=utf-8');
      return;
    }
    if (isApi) {
      api(req, res, url, viewer).catch((err: unknown) => {
        log(`api error: ${err instanceof Error ? err.message : 'unexpected'}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      });
      return;
    }
    try {
      staticFile(req, res, url);
    } catch {
      if (!res.headersSent) send(res, 500, 'internal error\n', 'text/plain; charset=utf-8');
    }
  }

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return {
    server,
    listen: (p: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, hosted ? '0.0.0.0' : '127.0.0.1', () => {
          server.off('error', reject);
          port = (server.address() as AddressInfo).port;
          resolve(port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
