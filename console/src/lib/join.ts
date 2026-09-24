// The join panel's commands, built from GET /api/join and the viewer's email (when /api/me
// gives one). Nothing here is hardcoded to a team: the relay, team, repository, marketplace
// and plugin all come from the console server. The steps follow plugin/README.md (Install,
// Running the working session, Running the answering session).

import type { Join } from '@/api/types'

/** Stands in for the viewer's email when the server does not give it. */
export const EMAIL_PLACEHOLDER = '<you>@<domain>'
/** Where the clone lands; the steps after it use this path. */
export const CLONE_DIR = 'team-relay'
export const CLONE_PATH = `/path/to/${CLONE_DIR}`

export const MIN_CLAUDE_CODE = '2.1.280'
export const MIN_NODE = '22'

const EMAIL_RE = /^[^\s@<>"'`$;&|\\]{1,64}@[^\s@<>"'`$;&|\\]{1,253}$/

/** The viewer's email if it is a plain address, else the placeholder. */
export function viewerEmail(email: string | null | undefined): string {
  return email && EMAIL_RE.test(email) ? email : EMAIL_PLACEHOLDER
}

export interface JoinCommands {
  signIn: string
  clone: string | null
  marketplaceAdd: string
  install: string
  working: string
  answering: string
  /** What the plugin's install questions should be answered with, in order. */
  answers: Array<{ key: string; value: string }>
}

export function joinCommands(join: Join, email: string): JoinCommands {
  const ref = `${join.plugin}@${join.marketplace}`
  return {
    signIn: `gcloud auth login ${email}`,
    clone: join.repo_url ? `git clone ${join.repo_url} ${CLONE_DIR}` : null,
    marketplaceAdd: `/plugin marketplace add ${CLONE_PATH}`,
    install: `/plugin install ${ref}`,
    working: `claude --dangerously-load-development-channels plugin:${ref}`,
    answering: [
      `export RELAY_URL=${join.relay_url}`,
      `export RELAY_TEAM=${join.team}`,
      `export RELAY_GCLOUD_ACCOUNT=${email}`,
      `${CLONE_PATH}/plugin/bin/answerer`,
    ].join('\n'),
    answers: [
      { key: 'relay_url', value: join.relay_url },
      { key: 'relay_team', value: join.team },
      { key: 'relay_auth', value: 'google' },
      { key: 'gcloud_account', value: email },
    ],
  }
}
