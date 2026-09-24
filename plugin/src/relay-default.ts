// The relay the plugin talks to when nothing else is said (M5-SPEC §6): read at run time
// from plugin/relay.default.json, the one place the default lives, so no bundle carries a
// copy. `/team-relay:login <relay-url>` (and RELAY_URL) override it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRelayUrl } from './relay-client-core.js';

/** plugin/relay.default.json, next to dist/ (the bundles live in dist/). */
export function defaultRelayFile(): string {
  return fileURLToPath(new URL('../relay.default.json', import.meta.url));
}

/** The default relay URL, or null when the file is absent or unusable. */
export function defaultRelayUrl(file: string = defaultRelayFile()): string | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { relay_url?: unknown };
    if (typeof raw.relay_url !== 'string') return null;
    parseRelayUrl(raw.relay_url);
    return raw.relay_url;
  } catch {
    return null;
  }
}
