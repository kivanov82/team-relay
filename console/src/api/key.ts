// The console key arrives once, in the URL fragment the console server prints
// (`http://127.0.0.1:<port>/#k=<key>`, M2 §4.4). It is read at start-up, kept in memory
// only (never storage), and removed from the address bar so it is not left in history,
// bookmarks or a screen share.

const KEY_RE = /^[A-Za-z0-9_-]{16,256}$/

let key: string | null = null

/** Reads `#k=<key>` from the location, remembers it, and strips the fragment. */
export function takeKeyFromLocation(loc: Location = window.location, hist: History = window.history): string | null {
  const hash = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash
  if (hash) {
    const candidate = new URLSearchParams(hash).get('k')
    if (candidate !== null && KEY_RE.test(candidate)) {
      key = candidate
    }
    try {
      hist.replaceState(hist.state, '', loc.pathname + loc.search)
    } catch {
      // A sandboxed document may refuse; the key is still only in memory.
    }
  }
  return key
}

export function consoleKey(): string | null {
  return key
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * The hosted console (M3 §4) is served from its Cloud Run host behind IAP, which is the
 * gate: its API needs no key. The local console server only ever answers on a loopback
 * address, where a key is required as before.
 */
export function isHosted(loc: Location = window.location): boolean {
  return !LOOPBACK.has(loc.hostname)
}

/** Tests only. */
export function setConsoleKey(value: string | null): void {
  key = value
}
