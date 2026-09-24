// The relay's id shapes and URL rule, shared by the client and the credential file (kept
// apart from relay-client.ts so the two can import them without a cycle).

export const TEAM_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const MEMBER_RE = /^[a-z][a-z0-9_]{1,31}$/;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** https everywhere; plain http only to a loopback address (local development). */
export function parseRelayUrl(raw: string | undefined): URL {
  if (!raw) throw new Error('RELAY_URL must be set');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('RELAY_URL is not a valid URL');
  }
  if (url.username || url.password) throw new Error('RELAY_URL must not carry credentials');
  if (url.search || url.hash) throw new Error('RELAY_URL must not carry a query or fragment');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
  throw new Error('RELAY_URL must be https (plain http is allowed only to localhost)');
}
