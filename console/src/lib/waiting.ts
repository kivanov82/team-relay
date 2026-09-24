// Questions waiting for an answering session (M7 §1, §3): shown only while that session is
// not online (polled within 45 s), as the plugin's notice is.

import type { ApprovalsSummary, DirectoryMember, InboxSummary } from '@/api/types'
import { presenceOf } from './presence'

/** A teammate's waiting count for their card, or null when there is nothing to show. */
export function agentWaiting(agent: DirectoryMember, now: number): number | null {
  const n = agent.inbox_waiting
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null
  if (presenceOf(agent.sessions.answering.last_seen, now) === 'online') return null
  return n
}

/** The header's line for the viewer ("2 questions waiting for you"), or null. */
export function waitingLine(summary: InboxSummary | undefined, now: number): string | null {
  if (!summary || typeof summary.pending !== 'number' || summary.pending <= 0) return null
  if (presenceOf(summary.answering?.last_seen ?? null, now) === 'online') return null
  const more = summary.more === true
  const count = more ? `${summary.pending}+` : String(summary.pending)
  return `${count} ${summary.pending === 1 && !more ? 'question' : 'questions'} waiting for you`
}

/** M8 §5: the header's line for answers waiting for the viewer's approval, or null. */
export function approvalsLine(summary: ApprovalsSummary | undefined): string | null {
  const n = summary?.pending
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null
  return `${n} ${n === 1 ? 'answer' : 'answers'} waiting for your approval`
}
