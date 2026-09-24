// The live activity model: an incremental merge of GET /api/activity pages (M2 §3.5) by
// request_id, the cursor (`next_since`) the next poll resumes from, and the derived views
// the console draws (the list, the filters, the edges in flight on the team map).

import type { ActivityPage, ActivityRequest } from '@/api/types'
import { IN_FLIGHT, phaseOf, settledAt, type Phase } from './steps'
import { ms } from './time'

/** At most this many requests are kept in memory; the oldest fall off first. */
export const MAX_REQUESTS = 500

/**
 * Each poll re-reads this much before the cursor (M2 §7.1). `updated_at` is monotonic per
 * document, but commits to different documents can land out of timestamp order: a change
 * stamped 10:00:01.000 may become visible after one stamped 10:00:01.500 was already read.
 * The overlap picks such a change up on the next poll; the merge is idempotent.
 */
export const OVERLAP_MS = 30_000

export interface ActivityState {
  byId: Record<string, ActivityRequest>
  /** The cursor for the next poll; null until the first page arrives (then: last 24 h). */
  nextSince: string | null
  /** server_time minus the local clock when the page arrived, for clock-skew-free ages. */
  serverOffsetMs: number
  rttMs: number | null
  receivedAt: number | null
}

export function emptyActivity(): ActivityState {
  return { byId: {}, nextSince: null, serverOffsetMs: 0, rttMs: null, receivedAt: null }
}

export function mergeActivity(
  prev: ActivityState,
  page: ActivityPage,
  receivedAt: number,
  rttMs: number | null,
): ActivityState {
  const serverNow = ms(page.server_time)
  const serverOffsetMs = serverNow === null ? prev.serverOffsetMs : serverNow - receivedAt
  const now = receivedAt + serverOffsetMs

  const byId: Record<string, ActivityRequest> = { ...prev.byId }
  for (const req of page.requests) {
    const existing = byId[req.request_id]
    // The overlap re-reads, and commits land out of order across documents: an equal or
    // newer updated_at replaces what is held, an older one never does.
    if (existing && (ms(existing.updated_at) ?? 0) > (ms(req.updated_at) ?? 0)) continue
    byId[req.request_id] = req
  }

  // Expired requests are gone at the relay (M1 §3.11, TTL); drop them here too.
  const kept = Object.values(byId).filter((r) => (ms(r.expire_at) ?? Infinity) > now)
  kept.sort((a, b) => (ms(b.updated_at) ?? 0) - (ms(a.updated_at) ?? 0))
  const next: Record<string, ActivityRequest> = {}
  for (const r of kept.slice(0, MAX_REQUESTS)) next[r.request_id] = r

  return {
    byId: next,
    nextSince: laterCursor(prev.nextSince, page.next_since),
    serverOffsetMs,
    rttMs,
    receivedAt,
  }
}

/**
 * The stored cursor only moves forward. A poll starts OVERLAP_MS before it, and the relay
 * answers an empty window with `next_since = since`; taking that as the new cursor would
 * walk it back by the overlap on every quiet poll.
 */
export function laterCursor(prev: string | null, next: string | null): string | null {
  if (next === null) return prev
  if (prev === null) return next
  return (ms(next) ?? -Infinity) >= (ms(prev) ?? -Infinity) ? next : prev
}

/** Where a poll starts reading: the cursor less the overlap, or null (the last 24 h). */
export function overlapSince(cursor: string | null): string | null {
  const t = ms(cursor)
  return t === null ? null : new Date(t - OVERLAP_MS).toISOString()
}

export type FetchPage = (since: string | null) => Promise<{ data: ActivityPage; rttMs: number | null }>

export interface PollOptions {
  /** A page at least this long means more may be waiting. */
  pageSize: number
  /** A backlog larger than one page is drained in this many pages per poll at most. */
  maxPages: number
  /** The local clock, for the arrival time of each page. */
  clock?: () => number
}

export class PollError extends Error {
  /** What the pages that did arrive before the failure add up to, if any arrived. */
  readonly partial: ActivityState | null

  constructor(cause: unknown, partial: ActivityState | null) {
    super(cause instanceof Error ? cause.message : 'poll failed', { cause })
    this.name = 'PollError'
    this.partial = partial
  }
}

/**
 * One poll of the feed (M2 §3.5, §7.1): the first page from the cursor less the overlap,
 * further pages (a backlog, or a page grown past `limit` to keep an equal-`updated_at`
 * group whole, M2 §7.10) from the `next_since` the previous page returned.
 */
export async function pollActivity(prev: ActivityState, fetchPage: FetchPage, opts: PollOptions): Promise<ActivityState> {
  const clock = opts.clock ?? Date.now
  let state = prev
  let since = overlapSince(prev.nextSince)
  for (let n = 0; n < opts.maxPages; n++) {
    let page: { data: ActivityPage; rttMs: number | null }
    try {
      page = await fetchPage(since)
    } catch (err) {
      throw new PollError(err, n > 0 ? state : null)
    }
    state = mergeActivity(state, page.data, clock(), page.rttMs)
    const next = page.data.next_since
    if (page.data.requests.length < opts.pageSize || next === null || next === since) break
    since = next
  }
  return state
}

/** Newest first, by creation, so a row stays in place while its steps advance. */
export function sortedRequests(state: ActivityState): ActivityRequest[] {
  return Object.values(state.byId).sort((a, b) => {
    const d = (ms(b.created_at) ?? 0) - (ms(a.created_at) ?? 0)
    return d !== 0 ? d : b.request_id.localeCompare(a.request_id)
  })
}

export type Filter = 'all' | 'mine' | 'open'

export function isOpen(req: ActivityRequest): boolean {
  return Object.values(req.recipients).some((r) => IN_FLIGHT.has(phaseOf(r)))
}

export function involves(req: ActivityRequest, member: string): boolean {
  return req.asker === member || member in req.recipients
}

export function applyFilter(reqs: ActivityRequest[], filter: Filter, me: string | null): ActivityRequest[] {
  switch (filter) {
    case 'all':
      return reqs
    case 'mine':
      return me === null ? [] : reqs.filter((r) => involves(r, me))
    case 'open':
      return reqs.filter(isOpen)
  }
}

export type Tone = 'live' | 'ok' | 'warn' | 'bad' | 'muted'

export interface Summary {
  tone: Tone
  label: string
}

const PHASE_TONE: Record<Phase, Tone> = {
  sending: 'live',
  delivered: 'live',
  working: 'live',
  awaiting_access: 'warn',
  returning: 'live',
  answered: 'ok',
  no_response: 'warn',
  timed_out: 'bad',
}

export function phaseTone(p: Phase): Tone {
  return PHASE_TONE[p]
}

/** One status for a whole request: a single recipient's phase, or a count for a fan-out. */
export function summarize(req: ActivityRequest): Summary {
  const phases = Object.values(req.recipients).map(phaseOf)
  const n = phases.length
  if (n === 0) return { tone: 'muted', label: 'No recipients' }
  if (n === 1) {
    const p = phases[0] as Phase
    return { tone: PHASE_TONE[p], label: SHORT_PHASE[p] }
  }
  const answered = phases.filter((p) => p === 'answered' || p === 'returning').length
  if (phases.some((p) => IN_FLIGHT.has(p))) return { tone: 'live', label: `${answered} of ${n} answered` }
  if (answered === n) return { tone: 'ok', label: `All ${n} answered` }
  if (answered === 0) {
    return phases.some((p) => p === 'timed_out')
      ? { tone: 'bad', label: 'Timed out' }
      : { tone: 'warn', label: 'No response' }
  }
  return { tone: 'warn', label: `${answered} of ${n} answered` }
}

const SHORT_PHASE: Record<Phase, string> = {
  sending: 'Sent',
  delivered: 'Delivered',
  working: 'Working',
  awaiting_access: 'Needs access',
  returning: 'Returning',
  answered: 'Answered',
  no_response: 'No response',
  timed_out: 'Timed out',
}

/** From creation to the last recipient settling, or to now while any is in flight. */
export function elapsedMs(req: ActivityRequest, now: number): number {
  const start = ms(req.created_at) ?? now
  let end = start
  for (const r of Object.values(req.recipients)) {
    const s = settledAt(req, r)
    if (s === null) return Math.max(0, now - start)
    end = Math.max(end, s)
  }
  return Math.max(0, end - start)
}

export interface Flight {
  from: string
  to: string
  /** `out`: the question or call travelling to the recipient; `back`: the answer returning. */
  direction: 'out' | 'back'
  requestIds: string[]
  broadcast: boolean
}

/**
 * The edges in flight on the team map, one per ordered pair of members and direction.
 * A question stays "out" from creation until it is answered; the answer is "back" until
 * the asker's working session has received it.
 */
export function flights(reqs: ActivityRequest[]): Flight[] {
  const byEdge = new Map<string, Flight>()
  for (const req of reqs) {
    for (const [member, r] of Object.entries(req.recipients)) {
      const p = phaseOf(r)
      if (!IN_FLIGHT.has(p)) continue
      const back = p === 'returning'
      const from = back ? member : req.asker
      const to = back ? req.asker : member
      const direction = back ? 'back' : 'out'
      const key = `${from}>${to}:${direction}`
      const f = byEdge.get(key)
      if (f) {
        f.requestIds.push(req.request_id)
        f.broadcast ||= req.broadcast
      } else {
        byEdge.set(key, { from, to, direction, requestIds: [req.request_id], broadcast: req.broadcast })
      }
    }
  }
  return [...byEdge.values()]
}
