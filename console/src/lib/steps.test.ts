import { describe, expect, it } from 'vitest'

import type { ActivityRequest } from '@/api/types'
import { fixtureRequests, RQ } from '@/mock/fixtures'
import { accessWaitLabel, deriveTrack, effectiveRequest, effectiveStatus, pendingGrant, phaseOf, settledAt, usedTools } from './steps'

function req(id: string): ActivityRequest {
  const r = fixtureRequests.find((x) => x.request_id === id)
  if (!r) throw new Error(id)
  return r
}

function states(id: string, member: string) {
  const q = req(id)
  const r = q.recipients[member]
  if (!r) throw new Error(member)
  const t = deriveTrack(q, r)
  return { track: t, byKey: Object.fromEntries(t.steps.map((s) => [s.key, s])) }
}

describe('deriveTrack', () => {
  it('marks every step of an answered, returned exchange done, with hop latencies from the timestamps', () => {
    const { track, byKey } = states(RQ.answered, 'bob')
    expect(track.phase).toBe('answered')
    expect(track.focus).toBeNull()
    expect(track.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done'])
    expect(byKey.sent?.at).toBe(Date.parse('2026-09-23T10:02:10.000Z'))
    expect(byKey.sent?.hopMs).toBeNull()
    expect(byKey.delivered?.hopMs).toBe(640)
    expect(byKey.acked?.hopMs).toBe(2570)
    // Tools start 2.84 s after the ack; the first tool's time is the step's time.
    expect(byKey.tools?.at).toBe(Date.parse('2026-09-23T10:02:16.050Z'))
    expect(byKey.tools?.hopMs).toBe(2840)
    // The answer's hop is measured from the ack, not from the first tool.
    expect(byKey.answered?.hopMs).toBe(28_090)
    expect(byKey.returned?.hopMs).toBe(750)
  })

  it('waits on the answer while tools are running', () => {
    const { track, byKey } = states(RQ.working, 'bob')
    expect(track.phase).toBe('working')
    expect(track.focus).toBe('answered')
    expect(byKey.tools?.state).toBe('done')
    expect(byKey.answered?.state).toBe('current')
    expect(byKey.returned?.state).toBe('upcoming')
  })

  it('waits on the member to allow access while the most recent tool event is waiting (M4 §2)', () => {
    const { track, byKey } = states(RQ.grant, 'carol')
    expect(track.phase).toBe('awaiting_access')
    expect(track.focus).toBe('tools')
    expect(byKey.tools?.state).toBe('waiting')
    // The step's time is the first tool that ran (the Glob), not the request for access.
    expect(byKey.tools?.at).toBe(Date.parse('2026-09-23T10:12:47.100Z'))
    expect(byKey.answered?.state).toBe('upcoming')
    expect(byKey.returned?.state).toBe('upcoming')
    const r = req(RQ.grant).recipients.carol!
    expect(pendingGrant(r)).toBe('Read')
    expect(usedTools(r).map((t) => t.tool)).toEqual(['Glob'])
    expect(accessWaitLabel('carol', 'alice')).toBe('Waiting for carol to allow access')
    expect(accessWaitLabel('alice', 'alice')).toBe('Waiting for you to allow access')
  })

  it('is waiting even with no tool used yet, and the next event for that tool clears it', () => {
    const q: ActivityRequest = structuredClone(req(RQ.grant))
    const carol = q.recipients.carol!
    carol.tools = [{ tool: 'Grep', status: 'waiting', at: '2026-09-23T10:12:47.000Z', duration_ms: null }]
    let t = deriveTrack(q, carol)
    expect(t.phase).toBe('awaiting_access')
    expect(t.steps.find((s) => s.key === 'tools')).toMatchObject({ state: 'waiting', at: null })
    // Allowed: the Grep ran.
    carol.tools.push({ tool: 'Grep', status: 'ok', at: '2026-09-23T10:13:02.000Z', duration_ms: 40 })
    t = deriveTrack(q, carol)
    expect(t.phase).toBe('working')
    expect(pendingGrant(carol)).toBeNull()
    expect(t.steps.find((s) => s.key === 'tools')).toMatchObject({ state: 'done', at: Date.parse('2026-09-23T10:13:02.000Z') })
    // Denied, then it failed: an error clears it too.
    carol.tools.push({ tool: 'Read', status: 'waiting', at: '2026-09-23T10:13:05.000Z', duration_ms: null })
    expect(phaseOf(carol)).toBe('awaiting_access')
    carol.tools.push({ tool: 'Read', status: 'error', at: '2026-09-23T10:13:20.000Z', duration_ms: 2 })
    expect(phaseOf(carol)).toBe('working')
    // A second request for access waits again, on the newer tool.
    carol.tools.push({ tool: 'Glob', status: 'waiting', at: '2026-09-23T10:13:25.000Z', duration_ms: null })
    expect(pendingGrant(carol)).toBe('Glob')
  })

  it('stops waiting once the exchange settles, answered or out of time', () => {
    const q: ActivityRequest = structuredClone(req(RQ.grant))
    const carol = q.recipients.carol!
    expect(phaseOf({ ...carol, status: 'answered', answered_at: '2026-09-23T10:14:00.000Z' })).toBe('returning')
    expect(pendingGrant({ ...carol, status: 'answered' })).toBeNull()
    const late = effectiveRequest(q, Date.parse(q.answer_deadline))
    expect(phaseOf(late.recipients.carol!)).toBe('timed_out')
    const t = deriveTrack(late, late.recipients.carol!)
    expect(t.steps.map((s) => s.state)).not.toContain('waiting')
  })

  it('waits on the ack once delivered', () => {
    const { track, byKey } = states(RQ.incoming, 'alice')
    expect(track.phase).toBe('delivered')
    expect(byKey.delivered?.state).toBe('done')
    expect(byKey.acked?.state).toBe('current')
    expect(byKey.tools?.state).toBe('upcoming')
  })

  it('waits on the return trip once answered but not yet picked up', () => {
    const { track, byKey } = states(RQ.returning, 'carol')
    expect(track.phase).toBe('returning')
    expect(byKey.answered?.state).toBe('done')
    expect(byKey.returned?.state).toBe('current')
  })

  it('fails a never-delivered broadcast recipient at delivery when the ack deadline passes', () => {
    const { track, byKey } = states(RQ.broadcast, 'carol')
    expect(track.phase).toBe('no_response')
    expect(byKey.delivered?.state).toBe('failed')
    expect(byKey.acked?.state).toBe('upcoming')
    expect(byKey.tools?.state).toBe('skipped')
    expect(settledAt(req(RQ.broadcast), req(RQ.broadcast).recipients.carol!)).toBe(Date.parse('2026-09-23T10:07:00.000Z'))
  })

  it('fails a timed-out exchange at the answer, keeping the tools it ran', () => {
    const { track, byKey } = states(RQ.timedOut, 'carol')
    expect(track.phase).toBe('timed_out')
    expect(track.focus).toBe('answered')
    expect(byKey.acked?.state).toBe('done')
    expect(byKey.tools?.state).toBe('done')
    expect(byKey.answered?.state).toBe('failed')
    expect(byKey.returned?.state).toBe('upcoming')
  })

  it('marks tools skipped when an answer came without any', () => {
    const q: ActivityRequest = structuredClone(req(RQ.answered))
    q.recipients.bob!.tools = []
    const t = deriveTrack(q, q.recipients.bob!)
    expect(t.steps.find((s) => s.key === 'tools')?.state).toBe('skipped')
    expect(t.steps.find((s) => s.key === 'answered')?.hopMs).toBe(28_090)
  })

  it('counts an ack as delivery when the delivery time was never recorded', () => {
    const q: ActivityRequest = structuredClone(req(RQ.working))
    q.recipients.bob!.delivered_at = null
    const t = deriveTrack(q, q.recipients.bob!)
    const delivered = t.steps.find((s) => s.key === 'delivered')
    expect(delivered?.state).toBe('done')
    expect(delivered?.at).toBeNull()
    // The ack's hop then runs from the last step with a time: sent.
    expect(t.steps.find((s) => s.key === 'acked')?.hopMs).toBe(4100)
  })

  it('reads the phase from the status and the recorded times', () => {
    expect(phaseOf(req(RQ.masked).recipients.bob!)).toBe('answered')
    expect(phaseOf({ ...req(RQ.incoming).recipients.alice!, delivered_at: null })).toBe('sending')
  })
})

describe('effective status from the server clock (M2 §7.2)', () => {
  const at = (s: string) => Date.parse(s)

  it('turns pending into no response at the ack deadline, not a millisecond before', () => {
    const q = req(RQ.incoming) // pending, delivered; ack deadline 10:16:52
    const r = q.recipients.alice!
    expect(effectiveStatus(q, r, at('2026-09-23T10:16:51.999Z'))).toBe('pending')
    expect(effectiveStatus(q, r, at('2026-09-23T10:16:52.000Z'))).toBe('no_response')
    expect(effectiveStatus(q, r, at('2026-09-23T10:30:00.000Z'))).toBe('no_response')
  })

  it('turns acked into timed out at the answer deadline, not a millisecond before', () => {
    const q = req(RQ.working) // acked; answer deadline 10:44:31
    const r = q.recipients.bob!
    expect(effectiveStatus(q, r, at('2026-09-23T10:44:30.999Z'))).toBe('acked')
    expect(effectiveStatus(q, r, at('2026-09-23T10:44:31.000Z'))).toBe('timed_out')
  })

  it('leaves an acked recipient alone past the ack deadline, and a settled one past both', () => {
    const working = req(RQ.working)
    expect(effectiveStatus(working, working.recipients.bob!, at('2026-09-23T10:20:00.000Z'))).toBe('acked')
    const answered = req(RQ.answered)
    expect(effectiveStatus(answered, answered.recipients.bob!, at('2026-09-24T00:00:00.000Z'))).toBe('answered')
    // Answered but not yet picked up by the asker: still on its way back, whatever the time.
    const returning = req(RQ.returning)
    expect(effectiveStatus(returning, returning.recipients.carol!, at('2026-09-24T00:00:00.000Z'))).toBe('answered')
  })

  it('returns the same object when nothing changes, a copy with the new status when it does', () => {
    const q = req(RQ.incoming)
    expect(effectiveRequest(q, at('2026-09-23T10:16:51.999Z'))).toBe(q)
    const past = effectiveRequest(q, at('2026-09-23T10:16:52.000Z'))
    expect(past).not.toBe(q)
    expect(past.recipients.alice?.status).toBe('no_response')
    expect(q.recipients.alice?.status).toBe('pending') // the held copy is untouched
  })

  it('draws the track stopped at the step it missed', () => {
    const late = effectiveRequest(req(RQ.incoming), at('2026-09-23T10:16:52.000Z'))
    const t = deriveTrack(late, late.recipients.alice!)
    expect(t.phase).toBe('no_response')
    expect(t.focus).toBe('acked')
    expect(t.steps.find((s) => s.key === 'acked')?.state).toBe('failed')
    expect(settledAt(late, late.recipients.alice!)).toBe(at('2026-09-23T10:16:52.000Z'))

    const over = effectiveRequest(req(RQ.working), at('2026-09-23T10:44:31.000Z'))
    const w = deriveTrack(over, over.recipients.bob!)
    expect(w.phase).toBe('timed_out')
    expect(w.focus).toBe('answered')
    expect(w.steps.find((s) => s.key === 'answered')?.state).toBe('failed')
  })
})
