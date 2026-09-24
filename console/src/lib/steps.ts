// The per-recipient step track (M2 §5): sent, delivered, acked, tools, answered, returned.
// Derived from the timestamps the relay records (M2 §3.2, §3.3; M1 §3.8, §3.9) and the
// recipient's status. The current step is the first one not yet reached; a request that
// ran out of time fails at that step instead.

import type { ActivityRecipient, ActivityRequest, RecipientStatus } from '@/api/types'
import { ms } from './time'

export type StepKey = 'sent' | 'delivered' | 'acked' | 'tools' | 'answered' | 'returned'

export type StepState =
  /** Reached, with or without a recorded time. */
  | 'done'
  /** The step the exchange is waiting on now. */
  | 'current'
  /** Not reached yet, and not the one being waited on. */
  | 'upcoming'
  /** Passed over: answered without using a tool. */
  | 'skipped'
  /** Where the exchange stopped: no ack in time, or no answer in time. */
  | 'failed'

export interface Step {
  key: StepKey
  label: string
  state: StepState
  /** When the step was reached, when the relay recorded it. */
  at: number | null
  /** Time since the previous step with a recorded time. */
  hopMs: number | null
}

export type Phase =
  | 'sending'
  | 'delivered'
  | 'working'
  | 'returning'
  | 'answered'
  | 'no_response'
  | 'timed_out'

export const STEP_LABEL: Record<StepKey, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  acked: 'Acknowledged',
  tools: 'Tools',
  answered: 'Answered',
  returned: 'Returned',
}

export const PHASE_LABEL: Record<Phase, string> = {
  sending: 'Waiting for delivery',
  delivered: 'Waiting for ack',
  working: 'Working',
  returning: 'Answer on its way back',
  answered: 'Answered',
  no_response: 'No response',
  timed_out: 'Timed out',
}

export const IN_FLIGHT: ReadonlySet<Phase> = new Set(['sending', 'delivered', 'working', 'returning'])

export function phaseOf(r: ActivityRecipient): Phase {
  switch (r.status) {
    case 'answered':
      return r.answer_delivered_at ? 'answered' : 'returning'
    case 'acked':
      return 'working'
    case 'pending':
      return r.delivered_at ? 'delivered' : 'sending'
    case 'no_response':
      return 'no_response'
    case 'timed_out':
      return 'timed_out'
  }
}

/**
 * The status as the relay's sweep would leave it at `now` (M2 §7.2). The feed reports the
 * stored status and does not run the sweep, so a recipient can read `pending` after its
 * ack deadline, or `acked` after its answer deadline. At the deadline itself the sweep
 * already counts it as missed (`now >= deadline`), and so does this.
 */
export function effectiveStatus(req: ActivityRequest, r: ActivityRecipient, now: number): RecipientStatus {
  if (r.status === 'pending' && now >= (ms(req.ack_deadline) ?? Infinity)) return 'no_response'
  if (r.status === 'acked' && now >= (ms(req.answer_deadline) ?? Infinity)) return 'timed_out'
  return r.status
}

/**
 * The request with every recipient at its effective status, by `now` on the server clock.
 * The same object comes back when nothing changed, so memoised views stay put.
 */
export function effectiveRequest(req: ActivityRequest, now: number): ActivityRequest {
  let recipients: Record<string, ActivityRecipient> | null = null
  for (const [m, r] of Object.entries(req.recipients)) {
    const status = effectiveStatus(req, r, now)
    if (status === r.status) continue
    recipients ??= { ...req.recipients }
    recipients[m] = { ...r, status }
  }
  return recipients === null ? req : { ...req, recipients }
}

export interface Track {
  steps: Step[]
  phase: Phase
  /** The highlighted step: the current one, or the failed one. Null once returned. */
  focus: StepKey | null
}

export function deriveTrack(req: ActivityRequest, r: ActivityRecipient): Track {
  const phase = phaseOf(r)
  const answered = r.status === 'answered'
  const acked = answered || r.status === 'acked' || r.status === 'timed_out' || ms(r.acked_at) !== null
  const delivered = acked || ms(r.delivered_at) !== null
  const firstTool = r.tools.length > 0 ? Math.min(...r.tools.map((t) => ms(t.at) ?? Infinity)) : null

  const reached: Record<StepKey, boolean> = {
    sent: true,
    delivered,
    acked,
    tools: r.tools.length > 0,
    answered,
    returned: answered && ms(r.answer_delivered_at) !== null,
  }
  const at: Record<StepKey, number | null> = {
    sent: ms(req.created_at),
    delivered: ms(r.delivered_at),
    acked: ms(r.acked_at),
    tools: firstTool !== null && Number.isFinite(firstTool) ? firstTool : null,
    answered: ms(r.answered_at),
    returned: ms(r.answer_delivered_at),
  }

  const order: StepKey[] = ['sent', 'delivered', 'acked', 'tools', 'answered', 'returned']
  const failed = phase === 'no_response' || phase === 'timed_out'

  // The step the exchange is waiting on (or stopped at): the first one not reached. Tools
  // are optional, so an exchange waiting for its answer after tools ran waits on
  // `answered`, and one that failed while working fails at `answered`, not at `tools`.
  let focus: StepKey | null = null
  for (const key of order) {
    if (reached[key]) continue
    if (key === 'tools' && (failed || answered)) continue
    focus = key
    break
  }

  let lastAt: number | null = null
  const steps: Step[] = order.map((key) => {
    let state: StepState
    if (reached[key]) state = 'done'
    else if (key === focus) state = failed ? 'failed' : 'current'
    else if (key === 'tools' && (answered || failed)) state = 'skipped'
    else state = 'upcoming'

    const t = reached[key] ? at[key] : null
    let hopMs: number | null = null
    if (t !== null && lastAt !== null && key !== 'sent') hopMs = Math.max(0, t - lastAt)
    // The tools step is a span, not a hop: the answer's latency is measured from the ack.
    if (t !== null && key !== 'tools') lastAt = t
    return { key, label: STEP_LABEL[key], state, at: t, hopMs }
  })

  return { steps, phase, focus }
}

/** The moment an exchange with this recipient settled, or null while it is in flight. */
export function settledAt(req: ActivityRequest, r: ActivityRecipient): number | null {
  switch (phaseOf(r)) {
    case 'answered':
      return ms(r.answer_delivered_at)
    case 'no_response':
      return ms(req.ack_deadline)
    case 'timed_out':
      return ms(req.answer_deadline)
    default:
      return null
  }
}
