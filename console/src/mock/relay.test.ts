import { describe, expect, it } from 'vitest'

import { ApiError, getJson, resetTransport, setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import type { ActivityRequest } from '@/api/types'
import { MockRelay } from './relay'
import { RQ } from './fixtures'

// The dev mock stands in for the relay behind the console server, so it has to mask the
// way the relay does (M2 §3.5, §7.8): the asker sees every answer preview, a recipient
// its own only, a non-participant no question, params or previews at all.

const T0 = Date.parse('2026-09-23T12:00:00.000Z')

function relayAt(viewer: string, sec: number) {
  let now = T0
  const relay = new MockRelay(() => now, viewer)
  now = T0 + sec * 1000
  return relay
}

function feed(relay: MockRelay): ActivityRequest[] {
  return relay.activity(null, 200).requests
}

function one(reqs: ActivityRequest[], pred: (r: ActivityRequest) => boolean): ActivityRequest {
  const found = reqs.filter(pred)
  expect(found).toHaveLength(1)
  return found[0]!
}

const bobsBroadcast = (r: ActivityRequest) => r.asker === 'bob' && r.broadcast
const alicesBroadcast = (r: ActivityRequest) => r.asker === 'alice' && r.broadcast && !Object.values(r.recipients).some((x) => x.status === 'no_response')
const carolAsksBob = (r: ActivityRequest) => r.asker === 'carol' && 'bob' in r.recipients && r.kind === 'question' && r.request_id !== RQ.masked
const dbQuery = (r: ActivityRequest) => r.capability?.name === 'staging_db_query' && r.request_id !== RQ.capability

describe('MockRelay masking', () => {
  it('shows a broadcast co-recipient its own answer preview and not the other recipient’s', () => {
    const q = one(feed(relayAt('alice', 60)), bobsBroadcast)
    expect(q.participant).toBe(true)
    expect(q.question).toMatch(/CI cache key/)
    expect(q.recipients.alice?.status).toBe('answered')
    expect(q.recipients.alice?.answer_preview).toMatch(/rebased/)
    // carol answered too, but only bob (the asker) may read it.
    expect(q.recipients.carol?.status).toBe('answered')
    expect(q.recipients.carol?.answer_preview).toBeNull()

    const asCarol = one(feed(relayAt('carol', 60)), bobsBroadcast)
    expect(asCarol.recipients.carol?.answer_preview).toMatch(/carol\/backfill/)
    expect(asCarol.recipients.alice?.answer_preview).toBeNull()
  })

  it('shows the asker every answer preview', () => {
    const asBob = one(feed(relayAt('bob', 60)), bobsBroadcast)
    expect(asBob.recipients.alice?.answer_preview).toMatch(/rebased/)
    expect(asBob.recipients.carol?.answer_preview).toMatch(/carol\/backfill/)

    const asAlice = one(feed(relayAt('alice', 75)), alicesBroadcast)
    expect(Object.values(asAlice.recipients).every((r) => r.answer_preview !== null)).toBe(true)
  })

  it('shows a non-participant metadata only: no question, no previews', () => {
    const q = one(feed(relayAt('alice', 85)), carolAsksBob)
    expect(q.participant).toBe(false)
    expect(q.question).toBeNull()
    expect(q.recipients.bob?.status).toBe('answered')
    expect(q.recipients.bob?.answer_preview).toBeNull()
    // The metadata stays: steps and tools.
    expect(q.recipients.bob?.acked_at).not.toBeNull()
    expect(q.recipients.bob?.tools.map((t) => t.tool)).toEqual(['Read'])

    // bob, the recipient, sees the question and his own answer.
    const asBob = one(feed(relayAt('bob', 85)), carolAsksBob)
    expect(asBob.question).toMatch(/connection limits/)
    expect(asBob.recipients.bob?.answer_preview).toMatch(/max_connections/)
  })

  it('withholds a capability call’s params from a non-participant but keeps its name and environment', () => {
    const asCarol = one(feed(relayAt('carol', 90)), dbQuery)
    expect(asCarol.participant).toBe(false)
    expect(asCarol.capability).toEqual({ name: 'staging_db_query', environment: 'staging', params: null })
    expect(asCarol.recipients.bob?.answer_preview).toBeNull()

    const asBob = one(feed(relayAt('bob', 90)), dbQuery)
    expect(asBob.capability?.params).toMatchObject({ dataset: 'events', limit: 50 })
    expect(asBob.recipients.bob?.answer_preview).toMatch(/50 rows/)
  })

  it('answers the side surface to participants only, a recipient seeing its own entry', () => {
    const asAlice = relayAt('alice', 60)
    const id = one(feed(asAlice), bobsBroadcast).request_id
    const d = asAlice.detail(id)
    expect(Object.keys(d?.recipients ?? {})).toEqual(['alice'])
    expect(d?.progress.every((p) => p.member === 'alice')).toBe(true)

    const nonParticipant = relayAt('alice', 85)
    expect(nonParticipant.detail(one(feed(nonParticipant), carolAsksBob).request_id)).toBeNull()
  })
})

describe('MockRelay feed and directory', () => {
  it('pages by next_since without losing or repeating a request', () => {
    const relay = relayAt('alice', 90)
    const all = feed(relay).map((r) => r.request_id)
    const seen: string[] = []
    let since: string | null = null
    for (let i = 0; i < 50; i++) {
      const page = relay.activity(since, 3)
      seen.push(...page.requests.map((r) => r.request_id))
      if (page.requests.length < 3) break
      since = page.next_since
    }
    expect(seen).toEqual(all)
  })

  it('counts a recipient as open only while its deadline is ahead, as the relay does (M2 §7.2)', () => {
    // alice asks carol at 86 s with a 10 s ack deadline; the sweep only runs at 99.5 s.
    const carolOpen = (sec: number) => relayAt('alice', sec).directory().members.find((m) => m.member === 'carol')?.stats.open
    expect(carolOpen(90)).toBe(1)
    expect(carolOpen(97)).toBe(0)

    // Meanwhile the feed still reports the stored status; the console derives the rest.
    const late = one(feed(relayAt('alice', 97)), (r) => r.question?.startsWith('Do you still have the load-test') ?? false)
    expect(late.recipients.carol?.status).toBe('pending')
    const swept = one(feed(relayAt('alice', 100)), (r) => r.question?.startsWith('Do you still have the load-test') ?? false)
    expect(swept.recipients.carol?.status).toBe('no_response')
  })

  it('reports whether the stats are complete', () => {
    expect(relayAt('alice', 10).directory().stats_complete).toBe(true)
  })

  it('refuses with the console server’s rate-limited shape, which the client reads as a slow-down', async () => {
    const relay = relayAt('alice', 10)
    relay.rateLimited = true
    setConsoleKey('k'.repeat(32))
    setTransport((path) => relay.handle(path))
    const err = await getJson('api/activity?limit=200').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).kind).toBe('rate_limited')
    resetTransport()
  })
})

describe('MockRelay access grants (M4 §2) and shares (M4 §3)', () => {
  it('starts with carol asked to allow a read, then carries on once she allows it', () => {
    const at = (sec: number) => one(feed(relayAt('alice', sec)), (r) => r.request_id === RQ.grant)
    expect(at(1).recipients.carol?.tools.at(-1)).toMatchObject({ tool: 'Read', status: 'waiting', duration_ms: null })
    expect(at(7).recipients.carol?.tools.at(-1)).toMatchObject({ tool: 'Read', status: 'ok' })
    expect(at(20).recipients.carol?.status).toBe('answered')
  })

  it('has bob wait for a grant in every round of traffic, then allow it', () => {
    const round = (sec: number) =>
      one(feed(relayAt('alice', sec)), (r) => r.asker === 'alice' && r.question !== null && /payments sandbox key/.test(r.question))
    expect(round(12).recipients.bob?.tools.map((t) => t.status)).toEqual(['ok', 'waiting'])
    expect(round(20).recipients.bob?.tools.map((t) => t.status)).toEqual(['ok', 'waiting', 'ok'])
  })

  it('publishes shares with the manifests', () => {
    const dir = relayAt('alice', 1).directory()
    expect(dir.members.find((m) => m.member === 'bob')?.manifest?.shares).toEqual([{ name: 'orders-service' }, { name: 'runbooks' }])
    expect(dir.members.find((m) => m.member === 'carol')?.manifest?.shares).toEqual([])
  })
})

describe('mock roster (M6 §2, §4)', () => {
  it('masks others’ emails for a member and refuses a member’s changes, as the relay does', async () => {
    const owner = relayAt('alice', 0)
    expect(owner.roster().members.map((m) => [m.member, m.role, m.emails?.every((e) => typeof e === 'string')])).toEqual([
      ['alice', 'owner', true],
      ['bob', 'member', true],
      ['carol', 'member', true],
      // M9 §7.2: an open invitation, which only owners see.
      ['dana', 'member', true],
    ])
    const added = owner.change('POST', '/api/roster', { member: 'erin', email: 'Erin@Example.com' })
    expect(added.status).toBe(201)
    expect(owner.roster().members.at(-1)).toMatchObject({ member: 'erin', emails: ['erin@example.com'], status: 'invited' })
    expect((await owner.change('POST', '/api/roster', { member: 'erin', email: 'x@example.com' }).json()).relay_status).toBe(409)
    expect((await owner.change('DELETE', '/api/roster/alice', undefined).json()).relay_error).toBe('last_owner')
    expect(owner.change('DELETE', '/api/roster/erin', undefined).status).toBe(200)

    const member = relayAt('alice', 0)
    member.role = 'member'
    const view = member.roster().members
    expect(view.find((m) => m.member === 'alice')).toMatchObject({ role: 'member', emails: ['alice@example.com'] })
    expect(view.find((m) => m.member === 'carol')!.emails).toEqual([null, null])
    expect((await member.change('POST', '/api/roster', { member: 'dana', email: 'dana@example.com' }).json()).relay_status).toBe(403)
  })

  it('answers not_on_team for a stranger, the join details included (M6 §7 item 6)', async () => {
    const relay = relayAt('alice', 0)
    expect((await relay.handle('api/join')).status).toBe(200)
    relay.stranger = true
    const join = await relay.handle('api/join')
    expect(join.status).toBe(403)
    expect(await join.json()).toEqual({ error: 'not_on_team', email: 'dana@example.com' })
    const r = await relay.handle('api/me')
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'not_on_team', email: 'dana@example.com' })
  })
})
