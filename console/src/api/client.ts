import { consoleKey, isHosted } from './key'
import type { ActivityPage, Directory, Join, Me, RequestDetail } from './types'

// Every call goes to the console server's read-only proxy: locally (M2 §4.4) with the key
// in X-Console-Key; hosted behind IAP (M3 §4) without a key, with the IAP session cookie.
// There is no write path in this client, by construction.

export type Transport = (path: string, init: RequestInit) => Promise<Response>

export type ApiErrorKind =
  /** The console server answered, but the relay behind it did not (502/503/504). */
  | 'relay_unreachable'
  /** Nothing answered at all: the console server is not running any more. */
  | 'server_unreachable'
  /** The key is missing, wrong or from an earlier launch (401/403). */
  | 'unauthorized'
  /**
   * Hosted: the IAP sign-in lapsed. The answer was a redirect (to Google's sign-in), not
   * JSON, or a refusal of the keyless call.
   */
  | 'session_expired'
  | 'not_found'
  /** The relay's per-member read budget is spent (429 rate_limited, M2 §7.3). */
  | 'rate_limited'
  | 'failed'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null
  /** For `rate_limited`: how long the server asked us to wait, when it said. */
  readonly retryAfterMs: number | null

  constructor(kind: ApiErrorKind, status: number | null, message: string, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

const TIMEOUT_MS = 10_000

let transport: Transport = (path, init) => fetch(path, init)

export function setTransport(next: Transport): void {
  transport = next
}

export function resetTransport(): void {
  transport = (path, init) => fetch(path, init)
}

export interface Timed<T> {
  data: T
  /** Round trip through the console server to the relay and back, in milliseconds. */
  rttMs: number
}

function expired(status: number | null): ApiError {
  return new ApiError('session_expired', status, 'The sign-in has expired')
}

function isJson(res: Response): boolean {
  return /^application\/json\b/i.test(res.headers.get('Content-Type') ?? '')
}

export async function getJson<T>(path: string): Promise<Timed<T>> {
  const key = consoleKey()
  const keyless = key === null
  if (keyless && !isHosted()) {
    throw new ApiError('unauthorized', null, 'No console key')
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (!keyless) headers['X-Console-Key'] = key
  const started = performance.now()
  let res: Response
  try {
    res = await transport(path, {
      method: 'GET',
      headers,
      // Hosted, IAP's session cookie must travel with the call (same origin only); the
      // local console server needs none.
      credentials: keyless ? 'same-origin' : 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      // An expired IAP session answers with a redirect to Google's sign-in: never follow it.
      redirect: 'manual',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : null,
    })
  } catch {
    throw new ApiError('server_unreachable', null, 'The console server did not answer')
  }
  const rttMs = Math.max(0, Math.round(performance.now() - started))
  if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 300 && res.status < 400)) {
    throw expired(res.status || null)
  }
  if (res.status === 401 || res.status === 403) {
    // Keyless (hosted) there is no key to refuse, and a refusal that is not the console
    // server's JSON came from IAP: either way, signing in again is the answer.
    if (keyless || !isJson(res)) throw expired(res.status)
    throw new ApiError('unauthorized', res.status, 'The console key was refused')
  }
  if (res.status === 404) {
    throw new ApiError('not_found', res.status, 'Not found')
  }
  if (res.status === 429) {
    throw new ApiError('rate_limited', res.status, 'Slowed down by the relay', retryAfter(res))
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    // The console server reports a relay refusal as 502 with the relay's status in the body
    // (plugin/src/console-app.ts); a refusal for being over the read budget is a slow-down,
    // not an outage.
    if (res.status === 502 && (await relayRateLimited(res))) {
      throw new ApiError('rate_limited', res.status, 'Slowed down by the relay', retryAfter(res))
    }
    throw new ApiError('relay_unreachable', res.status, 'The relay did not answer')
  }
  if (!res.ok) {
    throw new ApiError('failed', res.status, `Request failed with ${res.status}`)
  }
  // A page instead of JSON is IAP's sign-in (or its interstitial), not the console server.
  if (!isJson(res)) throw expired(res.status)
  let data: T
  try {
    data = (await res.json()) as T
  } catch {
    throw expired(res.status)
  }
  return { data, rttMs }
}

/** Retry-After in seconds (the only form a JSON API sends), capped at five minutes. */
function retryAfter(res: Response): number | null {
  const v = res.headers.get('Retry-After')
  if (v === null || !/^\d{1,6}$/.test(v.trim())) return null
  return Math.min(300, Number(v.trim())) * 1000
}

async function relayRateLimited(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null) return false
    const b = body as Record<string, unknown>
    return b.relay_status === 429 || b.relay_error === 'rate_limited' || b.error === 'rate_limited'
  } catch {
    return false
  }
}

export const api = {
  me: () => getJson<Me>('api/me'),
  directory: () => getJson<Directory>('api/directory'),
  join: () => getJson<Join>('api/join'),
  activity: (since: string | null, limit = 200) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (since !== null) q.set('since', since)
    return getJson<ActivityPage>(`api/activity?${q.toString()}`)
  },
  request: (id: string) => {
    if (!/^rq_[0-9a-f]{32}$/.test(id)) {
      return Promise.reject(new ApiError('not_found', null, 'Not a request id'))
    }
    return getJson<RequestDetail>(`api/requests/${id}`)
  },
}
