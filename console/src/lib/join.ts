// The join panel's commands (M5 §1: install the plugin, sign in, start answering), built from
// GET /api/join. Nothing here is hardcoded to a team: the marketplace source, marketplace,
// plugin and relay all come from the console server.

import type { Join } from '@/api/types'

/** Stands in for the viewer's email when the server does not give it. */
export const EMAIL_PLACEHOLDER = '<you>@<domain>'

export const MIN_CLAUDE_CODE = '2.1.280'
export const MIN_NODE = '22'

const EMAIL_RE = /^[^\s@<>"'`$;&|\\]{1,64}@[^\s@<>"'`$;&|\\]{1,253}$/
/** What `/plugin marketplace add` takes: owner/repo, or a plain https URL. */
const SOURCE_RE = /^(?:[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}|https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%+-]+)*\/?)$/
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%+-]*)*$/

/** The viewer's email if it is a plain address, else the placeholder. */
export function viewerEmail(email: string | null | undefined): string {
  return email && EMAIL_RE.test(email) ? email : EMAIL_PLACEHOLDER
}

export interface JoinCommands {
  /** `/plugin marketplace add <source>`, or null: ask the team owner where the plugin is. */
  marketplaceAdd: string | null
  install: string
  /** The working session with the team channel loaded (channels research preview). */
  working: string
  login: string
  answering: string
  console: string
}

export function joinCommands(join: Join): JoinCommands {
  const plugin = NAME_RE.test(join.plugin) ? join.plugin : 'team-relay'
  const marketplace = NAME_RE.test(join.marketplace) ? join.marketplace : 'team-relay-dev'
  const ref = `${plugin}@${marketplace}`
  const source = join.marketplace_source && SOURCE_RE.test(join.marketplace_source) ? join.marketplace_source : null
  // A bare /<plugin>:login reaches the plugin's own relay; any other relay is named.
  const relayArg = join.default_relay === true || !URL_RE.test(join.relay_url) ? '' : ` ${join.relay_url}`
  return {
    marketplaceAdd: source ? `/plugin marketplace add ${source}` : null,
    install: `/plugin install ${ref}`,
    working: `claude --dangerously-load-development-channels plugin:${ref}`,
    login: `/${plugin}:login${relayArg}`,
    answering: `/${plugin}:answering`,
    console: `/${plugin}:console`,
  }
}
