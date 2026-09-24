// The console's view of the relay, exactly as the local console server proxies it
// (docs/M2-SPEC.md §4.4). Shapes follow M2 §3.1 (directory sessions), §3.5 (the activity
// feed), §3.6 (directory stats) and M1 §3.2 / §3.11 (me, a request's side surface).
// Times are RFC 3339 UTC strings throughout.

export type Iso = string

/** GET /api/me (M1 §3.2). */
export interface Me {
  team: string
  member: string
  teammates: string[]
  /** The viewer's email, when the server gives it (the join panel's commands use it). */
  email?: string
  /** The viewer's role on the roster (M6), from relays that say. */
  role?: RosterRole
}

/**
 * GET /api/join: answered by the console server itself, never the relay (plugin/src/
 * console-app.ts). What a new member needs to install the plugin; nothing secret.
 */
export interface Join {
  relay_url: string
  team: string
  /** The team-relay repository, or null. */
  repo_url: string | null
  /**
   * What `/plugin marketplace add` takes (M5 §1): a GitHub owner/repo or a git URL, or null
   * (ask the team owner). Absent from older console servers.
   */
  marketplace_source?: string | null
  marketplace: string
  plugin: string
  /** True when the team's relay is the plugin's default, so a bare /team-relay:login reaches it. */
  default_relay?: boolean
}

export type RosterRole = 'owner' | 'member'

/**
 * One entry of GET /api/roster (M6 §2). Owners see every email; a member sees their own and
 * null for everyone else's.
 */
export interface RosterMember {
  member: string
  emails: Array<string | null> | null
  role: RosterRole
  added_by?: string | null
  added_at?: Iso | null
}

export interface Roster {
  members: RosterMember[]
}

export type Environment = 'staging' | 'production'

export interface ManifestParam {
  type: 'enum' | 'string' | 'integer' | 'number' | 'boolean'
  description: string
  values?: string[]
  default?: unknown
  min?: number
  max?: number
  max_length?: number
  pattern?: string
}

export interface ManifestCapability {
  name: string
  title: string
  description: string
  environment: Environment
  default_enabled?: boolean
  timeout_seconds?: number
  params: Record<string, ManifestParam>
  required?: string[]
}

/** A folder the member's answering session reads without asking, by name only (M4 §3). */
export interface ManifestShare {
  name: string
}

export interface Manifest {
  version: 1
  capabilities: ManifestCapability[]
  /** Absent from older plugins; an empty list is "shares nothing". */
  shares?: ManifestShare[]
}

export interface SessionPresence {
  last_seen: Iso | null
}

export interface MemberStats {
  asked: number
  answered: number
  open: number
  median_answer_seconds: number | null
}

/** One entry of GET /api/directory (M1 §3.4 with M2 §3.1 and §3.6). */
export interface DirectoryMember {
  member: string
  last_seen: Iso | null
  manifest: Manifest | null
  published_at: Iso | null
  sessions: {
    working: SessionPresence
    answering: SessionPresence
  }
  stats: MemberStats
}

export interface Directory {
  members: DirectoryMember[]
  /**
   * False when the 24 h window held more requests than the relay reads for stats: the
   * counts then cover the most recently updated ones only (M2 §7.10). Absent from older relays.
   */
  stats_complete?: boolean
}

export type RecipientStatus = 'pending' | 'acked' | 'answered' | 'no_response' | 'timed_out'

/**
 * M2 §3.3; `waiting` (M4 §2): the answering session is asking its member to allow the tool
 * (a read outside the shared folders). The next `ok` or `error` event for it clears that.
 */
export type ToolStatus = 'ok' | 'error' | 'waiting'

export interface ToolEvent {
  tool: string
  status: ToolStatus
  at: Iso
  duration_ms: number | null
}

export interface ActivityRecipient {
  status: RecipientStatus
  delivered_at: Iso | null
  acked_at: Iso | null
  answered_at: Iso | null
  answer_delivered_at: Iso | null
  tools: ToolEvent[]
  progress_count: number
  last_progress_pct: number | null
  /** Participants only; null for everyone else (M2 §3.5). */
  answer_preview: string | null
}

export interface ActivityCapability {
  name: string
  environment: Environment
  /** Participants only; null for everyone else. */
  params: Record<string, unknown> | null
}

/** One request in GET /api/activity (M2 §3.5). */
export interface ActivityRequest {
  request_id: string
  kind: 'question' | 'capability'
  asker: string
  broadcast: boolean
  created_at: Iso
  updated_at: Iso
  ack_deadline: Iso
  answer_deadline: Iso
  expire_at: Iso
  capability: ActivityCapability | null
  /** Participants only; null for everyone else, and for capability calls. */
  question: string | null
  recipients: Record<string, ActivityRecipient>
  participant: boolean
}

export interface ActivityPage {
  requests: ActivityRequest[]
  next_since: Iso | null
  server_time: Iso
}

/** A progress entry on GET /api/requests/{id}: M1 §3.11, with M2 §3.3's `kind`. */
export interface ProgressEntry {
  seq: number
  member: string
  kind?: 'progress' | 'tool'
  text?: string | null
  pct?: number | null
  time: Iso
  tool?: string
  status?: ToolStatus
  duration_ms?: number | null
}

/** GET /api/requests/{id} (M1 §3.11): the asker sees every recipient, a recipient itself. */
export interface RequestDetail {
  request_id: string
  kind: 'question' | 'capability'
  asker: string
  broadcast: boolean
  question: string | null
  capability: ActivityCapability | null
  created_at: Iso
  ack_deadline: Iso
  answer_deadline: Iso
  expire_at: Iso
  recipients: Record<string, Partial<ActivityRecipient> & { status: RecipientStatus }>
  progress: ProgressEntry[]
}
