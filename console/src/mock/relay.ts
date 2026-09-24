// A scripted, looping stand-in for the console server's /api/* (dev only: `pnpm dev` with
// VITE_MOCK=1, or `?mock` on the dev server). The fixture snapshot is re-based to the
// moment the mock starts, its in-flight requests carry on to completion, and a new round
// of traffic starts every CYCLE_MS, so the live behaviour (edges in flight, tracks
// advancing, presence changing, a broadcast fanning out, a request running out of time)
// can be watched without a relay. It masks exactly as the relay does (M2 §3.5, §7.8): a
// non-participant sees no question, params or answer previews; a recipient sees its own
// answer preview only; the asker sees every one.

import type {
  ActivityPage,
  ActivityRecipient,
  ActivityRequest,
  Directory,
  DirectoryMember,
  ProgressEntry,
  RequestDetail,
} from '@/api/types'
import { FIXTURE_NOW, RQ, fixtureCapabilityDetail, fixtureDirectory, fixtureJoin, fixtureMe, fixtureRequests } from './fixtures'

export const CYCLE_MS = 100_000
/** The relay keeps an equal-updated_at group whole on a page, up to this many (M2 §7.10). */
const MAX_GROUP = 500
const KEEP_CYCLES = 12
const DAY_MS = 24 * 3600_000

const iso = (t: number) => new Date(t).toISOString()
const parse = (s: string) => Date.parse(s)

interface ScriptEvent {
  at: number
  apply: (req: ActivityRequest, progress: ProgressEntry[]) => void
}

interface Script {
  base: ActivityRequest
  events: ScriptEvent[]
}

function blankRecipient(): ActivityRecipient {
  return {
    status: 'pending',
    delivered_at: null,
    acked_at: null,
    answered_at: null,
    answer_delivered_at: null,
    tools: [],
    progress_count: 0,
    last_progress_pct: null,
    answer_preview: null,
  }
}

function rec(req: ActivityRequest, m: string): ActivityRecipient {
  const r = req.recipients[m]
  if (!r) throw new Error(`no recipient ${m}`)
  return r
}

// Event builders --------------------------------------------------------------------------

const deliver = (m: string, at: number): ScriptEvent => ({
  at,
  apply: (q) => {
    rec(q, m).delivered_at ??= iso(at)
  },
})

const ack = (m: string, at: number): ScriptEvent => ({
  at,
  apply: (q) => {
    const r = rec(q, m)
    if (r.status === 'pending' || r.status === 'no_response') r.status = 'acked'
    r.acked_at ??= iso(at)
  },
})

const tool = (m: string, at: number, name: string, status: 'ok' | 'error', durationMs: number): ScriptEvent => ({
  at,
  apply: (q, progress) => {
    rec(q, m).tools.push({ tool: name, status, at: iso(at), duration_ms: durationMs })
    progress.push({
      seq: progress.length + 1,
      member: m,
      kind: 'tool',
      text: null,
      pct: null,
      tool: name,
      status,
      duration_ms: durationMs,
      time: iso(at),
    })
  },
})

/** M4 §2: the answering session asks its member to allow a tool (no duration). */
const waiting = (m: string, at: number, name: string): ScriptEvent => ({
  at,
  apply: (q, progress) => {
    rec(q, m).tools.push({ tool: name, status: 'waiting', at: iso(at), duration_ms: null })
    progress.push({
      seq: progress.length + 1,
      member: m,
      kind: 'tool',
      text: null,
      pct: null,
      tool: name,
      status: 'waiting',
      duration_ms: null,
      time: iso(at),
    })
  },
})

const step = (m: string, at: number, pct: number, text: string): ScriptEvent => ({
  at,
  apply: (q, progress) => {
    const r = rec(q, m)
    r.progress_count += 1
    r.last_progress_pct = pct
    progress.push({ seq: progress.length + 1, member: m, kind: 'progress', text, pct, time: iso(at) })
  },
})

const answer = (m: string, at: number, preview: string): ScriptEvent => ({
  at,
  apply: (q) => {
    const r = rec(q, m)
    r.status = 'answered'
    r.acked_at ??= iso(at)
    r.answered_at = iso(at)
    r.answer_preview = preview
  },
})

const returned = (m: string, at: number): ScriptEvent => ({
  at,
  apply: (q) => {
    rec(q, m).answer_delivered_at ??= iso(at)
  },
})

/** The lazy sweep (M1 §4): a pending recipient past the ack deadline, an acked one past the answer deadline. */
const sweep = (at: number): ScriptEvent => ({
  at,
  apply: (q) => {
    for (const r of Object.values(q.recipients)) {
      if (r.status === 'pending' && at >= parse(q.ack_deadline)) r.status = 'no_response'
      else if (r.status === 'acked' && at >= parse(q.answer_deadline)) r.status = 'timed_out'
    }
  },
})

// Scripts ---------------------------------------------------------------------------------

function hexId(seed: number): string {
  let h = (seed * 2654435761) >>> 0
  let out = ''
  for (let i = 0; i < 32; i++) {
    h = (Math.imul(h ^ (h >>> 15), 2246822519) + i * 374761393) >>> 0
    out += (h & 15).toString(16)
  }
  return `rq_${out}`
}

interface NewRequest {
  id: string
  at: number
  asker: string
  to: string[]
  broadcast?: boolean
  question?: string
  capability?: { name: string; environment: 'staging' | 'production'; params: Record<string, unknown> }
  ackS?: number
  answerS?: number
}

function base(n: NewRequest): ActivityRequest {
  const ackS = n.ackS ?? 120
  const answerS = n.answerS ?? 1800
  return {
    request_id: n.id,
    kind: n.capability ? 'capability' : 'question',
    asker: n.asker,
    broadcast: n.broadcast ?? false,
    created_at: iso(n.at),
    updated_at: iso(n.at),
    ack_deadline: iso(n.at + ackS * 1000),
    answer_deadline: iso(n.at + answerS * 1000),
    expire_at: iso(n.at + 7 * DAY_MS),
    capability: n.capability ?? null,
    question: n.question ?? null,
    recipients: Object.fromEntries(n.to.map((m) => [m, blankRecipient()])),
    participant: true,
  }
}

function cycleScripts(k: number, t0: number): Script[] {
  const s = (sec: number) => t0 + sec * 1000
  const id = (slot: number) => hexId(k * 16 + slot + 1)
  return [
    {
      base: base({
        id: id(0),
        at: s(2),
        asker: 'alice',
        to: ['bob'],
        question: 'Is the payments sandbox key in staging still the one issued in August?',
      }),
      events: [
        deliver('bob', s(2.7)),
        ack('bob', s(6.1)),
        tool('bob', s(9.4), 'Grep', 'ok', 51),
        // The key file is outside bob's shared folders: he is asked, and allows it.
        waiting('bob', s(10.3), 'Read'),
        tool('bob', s(19.2), 'Read', 'ok', 14),
        answer('bob', s(24.6), 'Yes. deploy/staging.env still references the August key; its rotation is scheduled for 1 October.'),
        returned('bob', s(25.8)),
      ],
    },
    {
      base: base({
        id: id(1),
        at: s(14),
        asker: 'bob',
        to: ['alice'],
        question: 'Which dashboard shows the ingest lag you mentioned this morning?',
      }),
      events: [
        deliver('alice', s(14.5)),
        ack('alice', s(18.2)),
        tool('alice', s(21.3), 'Read', 'ok', 11),
        answer('alice', s(33.9), 'The Grafana board "Ingest / lag by source", panel three. The staging lag spikes after each deploy.'),
        returned('alice', s(35.1)),
      ],
    },
    {
      base: base({
        id: id(2),
        at: s(28),
        asker: 'alice',
        to: ['carol'],
        capability: { name: 'service_health', environment: 'staging', params: { service: 'worker' } },
        ackS: 60,
        answerS: 60,
      }),
      events: [
        deliver('carol', s(28.8)),
        ack('carol', s(31.5)),
        step('carol', s(32.2), 50, 'Calling the worker health endpoint'),
        tool('carol', s(34.6), 'service_health', 'ok', 1320),
        answer('carol', s(36.1), 'worker is healthy: 200 in 112 ms, 0 errors in the last 15 minutes, queue depth 4.'),
        returned('carol', s(37.4)),
      ],
    },
    {
      base: base({
        id: id(3),
        at: s(44),
        asker: 'alice',
        to: ['bob', 'carol'],
        broadcast: true,
        question: 'Who owns the orders table migration that is blocking the release branch?',
      }),
      events: [
        deliver('bob', s(44.6)),
        deliver('carol', s(45.1)),
        ack('bob', s(48.9)),
        ack('carol', s(53.2)),
        tool('bob', s(51.0), 'Grep', 'ok', 66),
        tool('carol', s(56.4), 'Grep', 'error', 3),
        tool('carol', s(57.9), 'Grep', 'ok', 48),
        answer('bob', s(61.8), 'Not mine; git blame on the migration points at carol.'),
        returned('bob', s(62.9)),
        tool('carol', s(60.2), 'Read', 'ok', 17),
        answer('carol', s(70.4), 'Mine. It is waiting on the backfill; I will land it after the 14:00 freeze lifts.'),
        returned('carol', s(71.6)),
      ],
    },
    {
      base: base({
        id: id(4),
        at: s(58),
        asker: 'carol',
        to: ['bob'],
        question: 'Can you share the staging connection limits you tuned last week?',
      }),
      events: [
        deliver('bob', s(58.6)),
        ack('bob', s(62.3)),
        tool('bob', s(65.7), 'Read', 'ok', 13),
        answer('bob', s(79.2), 'max_connections 200, pool 40 per service, idle timeout 30 s.'),
        returned('bob', s(80.1)),
      ],
    },
    {
      base: base({
        id: id(5),
        at: s(72),
        asker: 'alice',
        to: ['bob'],
        capability: {
          name: 'staging_db_query',
          environment: 'staging',
          params: { dataset: 'events', field: 'created_on', op: 'gt', value: '2026-09-22', limit: 50 },
        },
        ackS: 60,
        answerS: 120,
      }),
      events: [
        deliver('bob', s(72.7)),
        ack('bob', s(75.0)),
        step('bob', s(75.8), 30, 'Reading events created after 2026-09-22'),
        tool('bob', s(78.9), 'staging_db_query', 'ok', 2410),
        step('bob', s(79.6), 80, '50 rows, summarising'),
        answer('bob', s(84.3), '50 rows (the limit). Most are checkout_started and payment_failed, all from the eu-west tenant.'),
        returned('bob', s(85.2)),
      ],
    },
    {
      base: base({
        id: id(6),
        at: s(86),
        asker: 'alice',
        to: ['carol'],
        question: 'Do you still have the load-test results from Tuesday?',
        ackS: 10,
        answerS: 60,
      }),
      // The feed reports the stored status (M2 §7.2): until the sweep runs, 3.5 s after the
      // ack deadline, the console derives "no response" from the deadline itself.
      events: [deliver('carol', s(86.8)), sweep(s(99.5))],
    },
    {
      // bob asks everyone: alice is a co-recipient, so she sees her own answer and not carol's.
      base: base({
        id: id(7),
        at: s(36),
        asker: 'bob',
        to: ['alice', 'carol'],
        broadcast: true,
        question: 'Is anyone still using the old CI cache key on their branch?',
      }),
      events: [
        deliver('alice', s(36.5)),
        deliver('carol', s(36.9)),
        ack('alice', s(39.4)),
        ack('carol', s(41.0)),
        tool('alice', s(42.1), 'Grep', 'ok', 42),
        answer('alice', s(47.3), 'Not on mine; my branches were rebased onto the new key on Monday.'),
        returned('alice', s(48.2)),
        tool('carol', s(44.8), 'Grep', 'ok', 58),
        answer('carol', s(52.6), 'One branch, carol/backfill; I will switch it over today.'),
        returned('carol', s(53.5)),
      ],
    },
  ]
}

/** The fixture's in-flight requests carry on from where the snapshot left them. */
function fixtureScripts(shift: number): Script[] {
  const at = (sec: number) => parse(FIXTURE_NOW) + shift + sec * 1000
  return fixtureRequests.map((req) => {
    const b = shiftRequest(req, shift)
    switch (req.request_id) {
      case RQ.working:
        return {
          base: b,
          events: [
            tool('bob', at(4), 'Read', 'ok', 16),
            tool('bob', at(7), 'Grep', 'ok', 39),
            answer('bob', at(15), 'Migration 0142_add_fulfilment_state added it on 12 September; staging is on 0144, so it is applied.'),
            returned('bob', at(16.2)),
          ],
        }
      case RQ.incoming:
        return {
          base: b,
          events: [
            ack('alice', at(5)),
            tool('alice', at(8), 'Read', 'ok', 10),
            answer('alice', at(19), 'Only in staging. Production rotates with the quarterly job on 1 October.'),
            returned('alice', at(20.4)),
          ],
        }
      case RQ.returning:
        return { base: b, events: [returned('carol', at(3))] }
      case RQ.grant:
        // carol allows the read; the answer follows.
        return {
          base: b,
          events: [
            tool('carol', at(6), 'Read', 'ok', 14),
            answer('carol', at(14), 'It says to page the platform on-call if the backlog stays above 5,000 for ten minutes.'),
            returned('carol', at(15.2)),
          ],
        }
      case RQ.capability:
        // Its progress notes, re-timed, so the detail sheet has them to show.
        return {
          base: b,
          events: fixtureCapabilityDetail.progress
            .filter((p) => p.kind === 'progress')
            .map((p) => {
              const t = parse(p.time) + shift
              return {
                at: t,
                apply: (_q: ActivityRequest, progress: ProgressEntry[]) => {
                  progress.push({ ...p, seq: progress.length + 1, time: iso(t) })
                },
              }
            }),
        }
      default:
        return { base: b, events: [] }
    }
  })
}

function shiftIso(s: string | null, shift: number): string | null {
  return s === null ? null : iso(parse(s) + shift)
}

function shiftRequest(req: ActivityRequest, shift: number): ActivityRequest {
  const q = structuredClone(req)
  q.created_at = iso(parse(q.created_at) + shift)
  q.updated_at = iso(parse(q.updated_at) + shift)
  q.ack_deadline = iso(parse(q.ack_deadline) + shift)
  q.answer_deadline = iso(parse(q.answer_deadline) + shift)
  q.expire_at = iso(parse(q.expire_at) + shift)
  for (const r of Object.values(q.recipients)) {
    r.delivered_at = shiftIso(r.delivered_at, shift)
    r.acked_at = shiftIso(r.acked_at, shift)
    r.answered_at = shiftIso(r.answered_at, shift)
    r.answer_delivered_at = shiftIso(r.answer_delivered_at, shift)
    for (const t of r.tools) t.at = iso(parse(t.at) + shift)
  }
  return q
}

// The relay stand-in ----------------------------------------------------------------------

interface Materialised {
  request: ActivityRequest
  progress: ProgressEntry[]
}

function materialise(script: Script, now: number): Materialised | null {
  if (parse(script.base.created_at) > now) return null
  const request = structuredClone(script.base)
  const progress: ProgressEntry[] = []
  let updated = parse(request.updated_at)
  for (const e of [...script.events].sort((a, b) => a.at - b.at)) {
    if (e.at > now) break
    e.apply(request, progress)
    updated = Math.max(updated, e.at)
  }
  request.updated_at = iso(updated)
  return { request, progress }
}

/** What `viewer` may see of a request, exactly as the relay's feed entry (M2 §3.5, §7.8). */
export function maskFor(viewer: string, req: ActivityRequest): ActivityRequest {
  const isAsker = req.asker === viewer
  const participant = isAsker || viewer in req.recipients
  const q = structuredClone(req)
  q.participant = participant
  if (!participant) {
    q.question = null
    if (q.capability) q.capability.params = null
  }
  for (const [m, r] of Object.entries(q.recipients)) {
    if (!isAsker && m !== viewer) r.answer_preview = null
  }
  return q
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const v = s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
  return Math.round(v * 10) / 10
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export class MockRelay {
  readonly startedAt: number
  /** Whose view this is: the relay masks per caller. The fixtures' viewer is alice. */
  readonly viewer: string
  reachable = true
  /** Answers every /api/* call with 429 rate_limited while set (M2 §7.3), for the dev view. */
  rateLimited = false
  private readonly shift: number
  private readonly now: () => number

  constructor(now: () => number = Date.now, viewer: string = fixtureMe.member) {
    this.now = now
    this.viewer = viewer
    this.startedAt = now()
    this.shift = this.startedAt - parse(FIXTURE_NOW)
  }

  private scripts(now: number): Script[] {
    const out = fixtureScripts(this.shift)
    const current = Math.floor((now - this.startedAt) / CYCLE_MS)
    for (let k = Math.max(0, current - KEEP_CYCLES); k <= current; k++) {
      out.push(...cycleScripts(k, this.startedAt + k * CYCLE_MS))
    }
    return out
  }

  state(now = this.now()): Materialised[] {
    return this.scripts(now)
      .map((s) => materialise(s, now))
      .filter((m): m is Materialised => m !== null && parse(m.request.expire_at) > now)
  }

  activity(since: string | null, limit: number, now = this.now()): ActivityPage {
    const from = since === null ? now - DAY_MS : parse(since)
    const docs = this.state(now)
      .map((m) => m.request)
      .filter((r) => parse(r.updated_at) > from)
      .sort((a, b) => parse(a.updated_at) - parse(b.updated_at) || a.request_id.localeCompare(b.request_id))
    // As the relay pages (M2 §7.10): never split a group of equal updated_at across pages.
    // Cut before the group that straddles the limit, or, when that group is the whole page,
    // return the group whole (at most MAX_GROUP).
    let rows = docs.slice(0, limit)
    const boundary = rows.at(-1)?.updated_at
    if (docs.length > limit && docs[limit]?.updated_at === boundary) {
      const before = rows.filter((r) => r.updated_at !== boundary)
      rows = before.length > 0 ? before : docs.filter((r) => r.updated_at === boundary).slice(0, MAX_GROUP)
    }
    const last = rows.at(-1)
    return {
      requests: rows.map((r) => maskFor(this.viewer, r)),
      next_since: last ? last.updated_at : since === null ? iso(from) : since,
      server_time: iso(now),
    }
  }

  directory(now = this.now()): Directory {
    const all = this.state(now).map((m) => m.request)
    const since = now - DAY_MS
    const recent = all.filter((r) => parse(r.created_at) > since)
    const fixtureIds = new Set(fixtureRequests.map((f) => f.request_id))
    const members: DirectoryMember[] = fixtureDirectory.members.map((m) => {
      const d = structuredClone(m)
      d.published_at = shiftIso(d.published_at, this.shift)
      const polling = iso(now - (now % 15_000)) // presence is written at most every 15 s
      if (m.member === 'bob') {
        d.sessions = { working: { last_seen: polling }, answering: { last_seen: polling } }
      } else {
        d.sessions = { working: { last_seen: this.carolWorkingSeen(now) }, answering: { last_seen: polling } }
      }
      d.last_seen =
        [d.sessions.working.last_seen, d.sessions.answering.last_seen]
          .filter((x): x is string => x !== null)
          .sort()
          .at(-1) ?? null

      // The fixture's stats are the 24 h baseline; the scripted rounds add to them.
      const scripted = recent.filter((r) => !fixtureIds.has(r.request_id))
      const mine = recent.flatMap((r) => {
        const s = r.recipients[m.member]
        return s ? [{ r, s }] : []
      })
      const answerSeconds = mine
        .filter(({ s }) => s.status === 'answered' && s.answered_at !== null)
        .map(({ r, s }) => (parse(s.answered_at ?? r.created_at) - parse(r.created_at)) / 1000)
      d.stats = {
        asked: m.stats.asked + scripted.filter((r) => r.asker === m.member).length,
        answered:
          m.stats.answered +
          scripted.filter((r) => r.recipients[m.member]?.status === 'answered').length,
        // Open only while the relevant deadline is ahead (M2 §7.2), as the relay counts it.
        open: mine.filter(
          ({ r, s }) =>
            (s.status === 'pending' && now < parse(r.ack_deadline)) ||
            (s.status === 'acked' && now < parse(r.answer_deadline)),
        ).length,
        median_answer_seconds: median(answerSeconds),
      }
      return d
    })
    return { members, stats_complete: true }
  }

  /**
   * carol's working session wakes up to ask her question in each round (50 s to 85 s into
   * it) and is idle the rest of the time; before her first round it is the fixture's.
   */
  private carolWorkingSeen(now: number): string {
    const t = now - this.startedAt
    const k = Math.floor(t / CYCLE_MS)
    const phase = t - k * CYCLE_MS
    if (phase >= 50_000 && phase < 85_000) return iso(now - (now % 15_000))
    const lastRound = phase >= 85_000 ? k : k - 1
    if (lastRound < 0) {
      const seen = fixtureDirectory.members.find((m) => m.member === 'carol')?.sessions.working.last_seen
      return iso(parse(seen ?? FIXTURE_NOW) + this.shift)
    }
    return iso(this.startedAt + lastRound * CYCLE_MS + 84_000)
  }

  detail(id: string, now = this.now()): RequestDetail | null {
    const found = this.state(now).find((m) => m.request.request_id === id)
    if (!found) return null
    const r = found.request
    const viewer = this.viewer
    const isAsker = r.asker === viewer
    if (!isAsker && !(viewer in r.recipients)) return null
    const visible = Object.fromEntries(Object.entries(r.recipients).filter(([m]) => isAsker || m === viewer))
    return {
      request_id: r.request_id,
      kind: r.kind,
      asker: r.asker,
      broadcast: r.broadcast,
      question: r.question,
      capability: r.capability,
      created_at: r.created_at,
      ack_deadline: r.ack_deadline,
      answer_deadline: r.answer_deadline,
      expire_at: r.expire_at,
      recipients: visible,
      progress: found.progress.filter((p) => isAsker || p.member === viewer),
    }
  }

  /** A Transport for the API client (src/api/client.ts). */
  handle = async (path: string): Promise<Response> => {
    await new Promise((resolve) => setTimeout(resolve, 35 + Math.random() * 70))
    const url = new URL(path, 'http://console.invalid/')
    const p = url.pathname.replace(/^\/+/, '/')
    // Answered by the console server itself, so it does not depend on the relay.
    if (p === '/api/join') return json(fixtureJoin)
    if (!this.reachable) return json({ error: 'relay_unreachable' }, 502)
    if (this.rateLimited) return json({ error: 'relay_refused', relay_status: 429, relay_error: 'rate_limited' }, 502)
    if (p === '/api/me') return json(fixtureMe)
    if (p === '/api/directory') return json(this.directory())
    if (p === '/api/activity') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100)))
      return json(this.activity(url.searchParams.get('since'), limit))
    }
    const m = /^\/api\/requests\/(rq_[0-9a-f]{32})$/.exec(p)
    if (m?.[1]) {
      const d = this.detail(m[1])
      return d ? json(d) : json({ error: 'not_found' }, 404)
    }
    return json({ error: 'not_found' }, 404)
  }
}
