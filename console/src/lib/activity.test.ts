import { describe, expect, it } from 'vitest'

import type { ActivityPage, ActivityRequest } from '@/api/types'
import { fixtureActivity, fixtureRequests, FIXTURE_NOW, RQ } from '@/mock/fixtures'
import {
  applyFilter,
  elapsedMs,
  emptyActivity,
  flights,
  laterCursor,
  MAX_REQUESTS,
  mergeActivity,
  OVERLAP_MS,
  overlapSince,
  pollActivity,
  PollError,
  sortedRequests,
  summarize,
} from './activity'
import { effectiveRequest } from './steps'

const NOW = Date.parse(FIXTURE_NOW)

function find(id: string): ActivityRequest {
  const r = fixtureRequests.find((x) => x.request_id === id)
  if (!r) throw new Error(id)
  return structuredClone(r)
}

function page(requests: ActivityRequest[], next: string | null, server = FIXTURE_NOW): ActivityPage {
  return { requests, next_since: next, server_time: server }
}

describe('mergeActivity', () => {
  it('takes the first page whole and remembers next_since', () => {
    const s = mergeActivity(emptyActivity(), fixtureActivity, NOW, 42)
    expect(Object.keys(s.byId)).toHaveLength(fixtureRequests.length)
    expect(s.nextSince).toBe(fixtureActivity.next_since)
    expect(s.rttMs).toBe(42)
  })

  it('replaces a request by request_id when a newer copy arrives, and adds new ones', () => {
    const first = mergeActivity(emptyActivity(), fixtureActivity, NOW, 10)
    const updated = find(RQ.working)
    updated.updated_at = '2026-09-23T10:15:02.000Z'
    updated.recipients.bob!.status = 'answered'
    updated.recipients.bob!.answered_at = '2026-09-23T10:15:02.000Z'
    const added: ActivityRequest = { ...find(RQ.incoming), request_id: 'rq_' + 'a'.repeat(32), updated_at: '2026-09-23T10:15:01.000Z' }

    const next = mergeActivity(first, page([added, updated], '2026-09-23T10:15:02.000Z', '2026-09-23T10:15:03.000Z'), NOW + 3000, 12)
    expect(Object.keys(next.byId)).toHaveLength(fixtureRequests.length + 1)
    expect(next.byId[RQ.working]?.recipients.bob?.status).toBe('answered')
    expect(next.byId[added.request_id]).toBeDefined()
    expect(next.nextSince).toBe('2026-09-23T10:15:02.000Z')
    // Untouched requests are carried over as they were.
    expect(next.byId[RQ.answered]).toBe(first.byId[RQ.answered])
  })

  it('never lets an older copy of a request replace a newer one', () => {
    const first = mergeActivity(emptyActivity(), fixtureActivity, NOW, 10)
    const stale = find(RQ.working)
    stale.updated_at = '2026-09-23T10:14:35.100Z'
    stale.recipients.bob!.tools = []
    const next = mergeActivity(first, page([stale], fixtureActivity.next_since), NOW, 10)
    expect(next.byId[RQ.working]?.recipients.bob?.tools).toHaveLength(1)
  })

  it('keeps the cursor when an empty page comes back without next_since', () => {
    const first = mergeActivity(emptyActivity(), fixtureActivity, NOW, 10)
    const next = mergeActivity(first, page([], null), NOW + 3000, 10)
    expect(next.nextSince).toBe(fixtureActivity.next_since)
  })

  it('drops requests past expire_at by the server clock, not the local one', () => {
    const first = mergeActivity(emptyActivity(), fixtureActivity, NOW, 10)
    // Eight days on at the server; the local clock is still at NOW.
    const later = new Date(NOW + 8 * 86_400_000).toISOString()
    const next = mergeActivity(first, page([], null, later), NOW, 10)
    expect(Object.keys(next.byId)).toHaveLength(0)
    expect(next.serverOffsetMs).toBe(8 * 86_400_000)
  })

  it(`keeps at most ${MAX_REQUESTS} requests, dropping the least recently updated`, () => {
    const many: ActivityRequest[] = Array.from({ length: MAX_REQUESTS + 5 }, (_, i) => ({
      ...find(RQ.answered),
      request_id: `rq_${i.toString(16).padStart(32, '0')}`,
      updated_at: new Date(NOW - 60_000 + i).toISOString(),
    }))
    const s = mergeActivity(emptyActivity(), page(many, null), NOW, 10)
    expect(Object.keys(s.byId)).toHaveLength(MAX_REQUESTS)
    expect(s.byId[`rq_${(0).toString(16).padStart(32, '0')}`]).toBeUndefined()
  })
})

describe('derived views', () => {
  const state = mergeActivity(emptyActivity(), fixtureActivity, NOW, 10)
  const all = sortedRequests(state)

  it('sorts newest first by creation', () => {
    expect(all[0]?.request_id).toBe(RQ.incoming)
    expect(all.at(-1)?.request_id).toBe(RQ.timedOut)
  })

  it('filters mine and open', () => {
    const mine = applyFilter(all, 'mine', 'alice').map((r) => r.request_id)
    expect(mine).not.toContain(RQ.masked)
    expect(mine).not.toContain(RQ.maskedCapability)
    expect(mine).toContain(RQ.incoming)
    const open = applyFilter(all, 'open', 'alice').map((r) => r.request_id).sort()
    expect(open).toEqual([RQ.incoming, RQ.returning, RQ.working].sort())
  })

  it('summarises a fan-out by counting answers', () => {
    expect(summarize(find(RQ.broadcast))).toEqual({ tone: 'warn', label: '1 of 2 answered' })
    expect(summarize(find(RQ.timedOut))).toEqual({ tone: 'bad', label: 'Timed out' })
    expect(summarize(find(RQ.working))).toEqual({ tone: 'live', label: 'Working' })
  })

  it('measures elapsed to the last settlement, or to now while in flight', () => {
    expect(elapsedMs(find(RQ.answered), NOW)).toBe(32_050)
    expect(elapsedMs(find(RQ.working), NOW)).toBe(29_000)
    // The broadcast settles when carol's ack deadline passes, after bob's answer returned.
    expect(elapsedMs(find(RQ.broadcast), NOW)).toBe(120_000)
  })

  it('draws a question out and an answer back as separate edges in their direction of travel', () => {
    const fl = flights(all)
    const keys = fl.map((f) => `${f.from}>${f.to}:${f.direction}`).sort()
    expect(keys).toEqual(['alice>bob:out', 'bob>alice:out', 'carol>alice:back'])
  })

  it('fans a broadcast out to every recipient still in flight', () => {
    const b = find(RQ.broadcast)
    b.recipients.bob = { ...b.recipients.bob!, status: 'acked', answered_at: null, answer_delivered_at: null }
    b.recipients.carol = { ...b.recipients.carol!, status: 'pending' }
    const fl = flights([b])
    expect(fl.map((f) => f.to).sort()).toEqual(['bob', 'carol'])
    expect(fl.every((f) => f.broadcast && f.direction === 'out' && f.from === 'alice')).toBe(true)
  })
})

describe('the cursor and the overlap (M2 §7.1)', () => {
  it('starts each poll 30 s before the cursor, and the first from nothing', () => {
    expect(OVERLAP_MS).toBe(30_000)
    expect(overlapSince(null)).toBeNull()
    expect(overlapSince('2026-09-23T10:15:00.000Z')).toBe('2026-09-23T10:14:30.000Z')
  })

  it('only ever moves the stored cursor forward', () => {
    expect(laterCursor(null, '2026-09-23T10:00:00.000Z')).toBe('2026-09-23T10:00:00.000Z')
    expect(laterCursor('2026-09-23T10:00:00.000Z', null)).toBe('2026-09-23T10:00:00.000Z')
    expect(laterCursor('2026-09-23T10:00:00.000Z', '2026-09-23T09:59:30.000Z')).toBe('2026-09-23T10:00:00.000Z')
    expect(laterCursor('2026-09-23T10:00:00.000Z', '2026-09-23T10:00:00.001Z')).toBe('2026-09-23T10:00:00.001Z')
  })

  it('lets an equal updated_at replace (the overlap re-reads) and an older one never', () => {
    const first = mergeActivity(emptyActivity(), fixtureActivity, NOW, 10)
    const same = find(RQ.working)
    same.recipients.bob!.progress_count = 7 // same stamp, as a re-read returns it
    const again = mergeActivity(first, page([same], fixtureActivity.next_since), NOW, 10)
    expect(again.byId[RQ.working]?.recipients.bob?.progress_count).toBe(7)

    const older = find(RQ.working)
    older.updated_at = '2026-09-23T10:14:38.999Z'
    older.recipients.bob!.progress_count = 99
    const kept = mergeActivity(again, page([older], fixtureActivity.next_since), NOW, 10)
    expect(kept.byId[RQ.working]?.recipients.bob?.progress_count).toBe(7)
  })

  it('is idempotent: merging the same page twice changes nothing', () => {
    const once = mergeActivity(emptyActivity(), fixtureActivity, NOW, 10)
    const twice = mergeActivity(once, fixtureActivity, NOW, 10)
    expect(twice.byId).toEqual(once.byId)
    expect(twice.nextSince).toBe(once.nextSince)
  })
})

/**
 * A relay feed over a store whose commits become visible out of timestamp order: each doc
 * is visible from `visibleAt` (the poll number it committed before) with its own stamp.
 */
function outOfOrderRelay(docs: { req: ActivityRequest; visibleAt: number }[]) {
  let poll = 0
  const calls: (string | null)[] = []
  const fetchPage = async (since: string | null) => {
    calls.push(since)
    const from = since === null ? -Infinity : Date.parse(since)
    const rows = docs
      .filter((d) => d.visibleAt <= poll && Date.parse(d.req.updated_at) > from)
      .map((d) => d.req)
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
    return { data: page(rows, rows.at(-1)?.updated_at ?? since, FIXTURE_NOW), rttMs: 5 }
  }
  return {
    calls,
    fetchPage,
    next() {
      poll += 1
    },
  }
}

function doc(n: number, updated: string): ActivityRequest {
  return { ...find(RQ.answered), request_id: `rq_${n.toString(16).padStart(32, '0')}`, updated_at: updated }
}

describe('pollActivity with out-of-order commits', () => {
  const opts = { pageSize: 200, maxPages: 5, clock: () => NOW }

  it('picks up a change stamped earlier that committed after a later one was read', async () => {
    const late = doc(1, '2026-09-23T10:14:50.000Z') // stamped first, committed second
    const early = doc(2, '2026-09-23T10:14:52.000Z')
    const relay = outOfOrderRelay([
      { req: early, visibleAt: 0 },
      { req: late, visibleAt: 1 },
    ])

    const s1 = await pollActivity(emptyActivity(), relay.fetchPage, opts)
    expect(Object.keys(s1.byId)).toEqual([early.request_id])
    expect(s1.nextSince).toBe('2026-09-23T10:14:52.000Z')

    relay.next()
    const s2 = await pollActivity(s1, relay.fetchPage, opts)
    expect(relay.calls[1]).toBe('2026-09-23T10:14:22.000Z')
    expect(Object.keys(s2.byId).sort()).toEqual([late.request_id, early.request_id].sort())
    // Re-reading `early` in the overlap left the cursor where it was.
    expect(s2.nextSince).toBe('2026-09-23T10:14:52.000Z')

    // Without the overlap the late commit would have been missed for good.
    const blind = outOfOrderRelay([
      { req: early, visibleAt: 0 },
      { req: late, visibleAt: 1 },
    ])
    blind.next()
    const missed = await blind.fetchPage(s1.nextSince)
    expect(missed.data.requests).toHaveLength(0)
  })

  it('never lets a re-read of an older copy undo a newer one held', async () => {
    const v2 = doc(3, '2026-09-23T10:14:55.000Z')
    v2.recipients.bob!.progress_count = 2
    const s1 = mergeActivity(emptyActivity(), page([v2], v2.updated_at), NOW, 5)
    // A page that still carries the older stamp (a read raced the commit).
    const v1 = structuredClone(v2)
    v1.updated_at = '2026-09-23T10:14:54.000Z'
    v1.recipients.bob!.progress_count = 1
    const s2 = await pollActivity(s1, async () => ({ data: page([v1], v1.updated_at), rttMs: 5 }), opts)
    expect(s2.byId[v2.request_id]?.recipients.bob?.progress_count).toBe(2)
    expect(s2.nextSince).toBe(v2.updated_at)
  })

  it('pages on from next_since, without the overlap, while pages come back full', async () => {
    const calls: (string | null)[] = []
    const pages = [
      page([doc(10, '2026-09-23T10:14:40.000Z'), doc(11, '2026-09-23T10:14:41.000Z')], '2026-09-23T10:14:41.000Z'),
      // Grown past the limit to keep an equal-updated_at group whole (M2 §7.10).
      page(
        [doc(12, '2026-09-23T10:14:42.000Z'), doc(13, '2026-09-23T10:14:42.000Z'), doc(14, '2026-09-23T10:14:42.000Z')],
        '2026-09-23T10:14:42.000Z',
      ),
      page([doc(15, '2026-09-23T10:14:43.000Z')], '2026-09-23T10:14:43.000Z'),
    ]
    const start = { ...emptyActivity(), nextSince: '2026-09-23T10:14:45.000Z' }
    const s = await pollActivity(
      start,
      async (since) => {
        calls.push(since)
        return { data: pages[calls.length - 1]!, rttMs: 5 }
      },
      { ...opts, pageSize: 2 },
    )
    expect(calls).toEqual(['2026-09-23T10:14:15.000Z', '2026-09-23T10:14:41.000Z', '2026-09-23T10:14:42.000Z'])
    expect(Object.keys(s.byId)).toHaveLength(6)
    // All of it was older than the cursor held: the cursor stays.
    expect(s.nextSince).toBe('2026-09-23T10:14:45.000Z')
  })

  it('stops after maxPages, and hands back what arrived before a failure', async () => {
    let n = 0
    const full = async () => {
      n += 1
      const t = new Date(NOW - 60_000 + n * 1000).toISOString()
      return { data: page([doc(100 + n, t)], t), rttMs: 5 }
    }
    await pollActivity(emptyActivity(), full, { ...opts, pageSize: 1, maxPages: 3 })
    expect(n).toBe(3)

    let m = 0
    const failing = async () => {
      m += 1
      if (m === 2) throw new Error('429')
      const t = new Date(NOW - 5_000).toISOString()
      return { data: page([doc(200, t)], t), rttMs: 5 }
    }
    const err = await pollActivity(emptyActivity(), failing, { ...opts, pageSize: 1 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PollError)
    expect((err as PollError).cause).toEqual(new Error('429'))
    expect(Object.keys((err as PollError).partial?.byId ?? {})).toEqual([doc(200, '').request_id])

    const first = await pollActivity(emptyActivity(), async () => Promise.reject(new Error('down')), opts).catch((e: unknown) => e)
    expect((first as PollError).partial).toBeNull()
  })
})

describe('effective status in the derived views (M2 §7.2)', () => {
  it('neither animates nor counts as open once the deadline has passed', () => {
    const incoming = find(RQ.incoming) // pending, ack deadline 10:16:52
    const working = find(RQ.working) // acked, answer deadline 10:44:31
    const before = [incoming, working].map((r) => effectiveRequest(r, Date.parse('2026-09-23T10:16:51.999Z')))
    expect(flights(before).map((f) => `${f.from}>${f.to}`).sort()).toEqual(['alice>bob', 'bob>alice'])
    expect(applyFilter(before, 'open', 'alice')).toHaveLength(2)

    const pastAck = [incoming, working].map((r) => effectiveRequest(r, Date.parse('2026-09-23T10:16:52.000Z')))
    expect(flights(pastAck).map((f) => `${f.from}>${f.to}`)).toEqual(['alice>bob'])
    expect(applyFilter(pastAck, 'open', 'alice').map((r) => r.request_id)).toEqual([RQ.working])
    expect(summarize(pastAck[0]!)).toEqual({ tone: 'warn', label: 'No response' })

    const pastAnswer = [incoming, working].map((r) => effectiveRequest(r, Date.parse('2026-09-23T10:44:31.000Z')))
    expect(flights(pastAnswer)).toEqual([])
    expect(applyFilter(pastAnswer, 'open', 'alice')).toEqual([])
    expect(summarize(pastAnswer[1]!)).toEqual({ tone: 'bad', label: 'Timed out' })
    // Settled at the deadline, so the elapsed time stops there.
    expect(elapsedMs(pastAnswer[1]!, Date.parse('2026-09-23T11:00:00.000Z'))).toBe(30 * 60_000)
  })
})
