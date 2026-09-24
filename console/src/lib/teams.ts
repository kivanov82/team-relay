// The console's team rules (M9), as pure functions: which team to show, the team id made from
// a name (as the relay makes it), what is wrong with a new team before it is sent, and the
// relay's refusals in words.

import type { ChangeError } from '@/api/client'
import type { InvitationEntry, TeamEntry, Teams } from '@/api/types'
import { MEMBER_ID_RE } from './roster'

/** A team id the relay creates: a lower-case letter, then lower-case letters, digits or -, 3 to 32. */
export const NEW_TEAM_ID_RE = /^[a-z][a-z0-9-]{2,31}$/
export const TEAM_NAME_MAX = 60
/** Control, format (bidi, zero-width), private-use, unassigned and line/paragraph separators. */
const NAME_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u

const TEAM_RE = /^[a-z][a-z0-9_-]{1,31}$/

/**
 * GET /api/teams, kept to well-formed entries (whatever answered is never trusted to be
 * shaped); null when it is not a teams answer at all.
 */
export function readTeams(raw: unknown): Teams | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.teams) || typeof r.default_team !== 'string') return null
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const ok = (e: Record<string, unknown>) =>
    typeof e.team === 'string' && TEAM_RE.test(e.team) && typeof e.member === 'string' && MEMBER_ID_RE.test(e.member)
  const name = (e: Record<string, unknown>) => (typeof e.name === 'string' && e.name.trim() !== '' ? e.name : String(e.team))
  const teams: TeamEntry[] = r.teams.filter(obj).filter(ok).map((e) => ({
    team: String(e.team),
    name: name(e),
    member: String(e.member),
    role: e.role === 'owner' ? 'owner' : 'member',
  }))
  const invitations: InvitationEntry[] = (Array.isArray(r.invitations) ? r.invitations : []).filter(obj).filter(ok).map((e) => ({
    team: String(e.team),
    name: name(e),
    member: String(e.member),
    role: e.role === 'owner' ? 'owner' : 'member',
    invited_by_member: typeof e.invited_by_member === 'string' && MEMBER_ID_RE.test(e.invited_by_member) ? e.invited_by_member : null,
  }))
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
  return {
    teams,
    invitations,
    admin: r.admin === true,
    teams_created: count(r.teams_created),
    max_teams_created: count(r.max_teams_created),
    suggested_member: typeof r.suggested_member === 'string' && MEMBER_ID_RE.test(r.suggested_member) ? r.suggested_member : null,
    can_manage_teams: r.can_manage_teams !== false,
    default_team: r.default_team,
    ...(typeof r.email === 'string' && r.email.length <= 254 ? { email: r.email } : {}),
  }
}

/** Where the last choice is remembered, in this browser only. */
export const TEAM_STORAGE_KEY = 'team-relay.console.team'

export function storedTeam(): string | null {
  try {
    const v = window.localStorage.getItem(TEAM_STORAGE_KEY)
    return v && /^[a-z][a-z0-9_-]{1,31}$/.test(v) ? v : null
  } catch {
    return null
  }
}

export function rememberTeam(team: string): void {
  try {
    window.localStorage.setItem(TEAM_STORAGE_KEY, team)
  } catch {
    // Storage refused (a private window, a sandbox): the choice lasts for this page only.
  }
}

/**
 * The team to show: the one chosen now (if still one of the viewer's), else the one last
 * chosen in this browser, else the console's default, else the first. Null for no team.
 */
export function pickTeam(teams: Teams | undefined, chosen: string | null, stored: string | null = storedTeam()): string | null {
  const ids = (teams?.teams ?? []).map((t) => t.team)
  for (const candidate of [chosen, stored, teams?.default_team ?? null]) {
    if (candidate !== null && ids.includes(candidate)) return candidate
  }
  return ids[0] ?? null
}

/** The relay's rule (M9 §2): lower case, `-` for anything else, `team-` in front when needed. */
export function teamIdFromName(name: string): string {
  let id = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(id)) id = id ? `team-${id}` : 'team'
  id = id.slice(0, 32).replace(/-+$/, '')
  return id.length >= 3 ? id : `${id}-team`.slice(0, 32)
}

/** Typed ids are tidied as they go: lower case; a space, _ or . becomes -. */
export function tidyTeamId(v: string): string {
  return v
    .toLowerCase()
    .replace(/[\s_.]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32)
}

export type CreateField = 'name' | 'id' | 'member'

/** What is wrong with a new team before it is sent, and in which field; null when nothing. */
export function createProblem(name: string, id: string, member: string): { field: CreateField; message: string } | null {
  const n = name.trim()
  if (n === '') return { field: 'name', message: 'Give the team a name.' }
  if ([...n].length > TEAM_NAME_MAX) return { field: 'name', message: `A team name is at most ${TEAM_NAME_MAX} characters.` }
  if (NAME_FORBIDDEN_RE.test(n)) return { field: 'name', message: 'The name has an invisible or control character. Type it again.' }
  if (!NEW_TEAM_ID_RE.test(id)) {
    return { field: 'id', message: 'A team id is 3 to 32 characters: a lower-case letter, then lower-case letters, digits or -.' }
  }
  if (!MEMBER_ID_RE.test(member)) {
    return { field: 'member', message: 'Your member id starts with a lower-case letter, then lower-case letters, digits or _, 2 to 32 characters.' }
  }
  return null
}

/** Slots left of the most one account may create, or null when the relay did not say. */
export function slotsLeft(teams: Teams | undefined): number | null {
  if (!teams || teams.teams_created === null || teams.max_teams_created === null) return null
  return Math.max(0, teams.max_teams_created - teams.teams_created)
}

/** A refused creation in words, and the field it is about (null for the form as a whole). */
export function createRefusal(err: ChangeError, max: number | null): { field: CreateField | null; message: string } {
  switch (err.relayError) {
    case 'team_id_unavailable':
      return { field: 'id', message: 'That team id is taken or reserved. Choose another.' }
    case 'team_name_unavailable':
      return { field: 'name', message: 'A team the relay was set up with already has that name. Choose another.' }
    case 'team_limit':
      return {
        field: null,
        message: `You have created ${max ?? 'the most'} teams, the most one account may. Delete one of them to create another.`,
      }
    case 'rate_limited':
      return { field: null, message: 'Too many team creations from this account or network for now. Try again in an hour.' }
    case 'google_identity_required':
      return { field: null, message: 'Creating a team needs a Google sign-in. Open the team console, or sign in with /team-relay:login.' }
    case 'invalid_body':
      return { field: null, message: err.detail ?? 'The relay refused those values. Check the name and ids.' }
    default:
      if (err.status === 400) return { field: null, message: err.message }
      return { field: null, message: err.relayStatus !== null ? (err.detail ?? err.message) : err.message }
  }
}

/** A refused deletion (owner or admin) in words. */
export function deleteRefusal(err: ChangeError): string {
  switch (err.relayError) {
    case 'seed_team':
      return "This team comes from the relay's team file, so it cannot be deleted here. Ask whoever runs the relay."
    case 'forbidden':
      return err.relayStatus === 403 ? 'Only an owner of the team (or a relay admin) can delete it.' : err.message
    case 'confirm_mismatch':
      return 'Type the team id exactly to confirm.'
    case 'rate_limited':
      return 'Too many deletions for now. Try again later.'
    case 'google_identity_required':
      return 'Deleting a team needs a Google sign-in: use the team console.'
    default:
      return err.relayStatus === 404 ? 'That team no longer exists.' : err.message
  }
}

/** A refused invitation answer in words. */
export function invitationRefusal(err: ChangeError): string {
  if (err.relayStatus === 404) return 'That invitation is no longer open.'
  if (err.relayStatus === 403) return 'This invitation belongs to another Google account.'
  if (err.relayError === 'rate_limited') return 'Too many answers for now. Try again in a while.'
  return err.message
}
