import type { Step } from '@/lib/steps'
import { formatClock, formatDuration } from '@/lib/time'
import { cn } from '@/lib/utils'

function stepTitle(s: Step): string {
  const when = s.at !== null ? ` at ${formatClock(s.at)}` : ''
  const hop = s.hopMs !== null ? `, ${formatDuration(s.hopMs)} after the previous step` : ''
  switch (s.state) {
    case 'done':
      return `${s.label}${when}${hop}`
    case 'current':
      return `${s.label}: waiting`
    case 'failed':
      return `${s.label}: did not happen in time`
    case 'skipped':
      return `${s.label}: none used`
    case 'upcoming':
      return `${s.label}: not yet`
    case 'waiting':
      return `${s.label}: waiting for permission to use a tool`
  }
}

/**
 * Six steps as dots on a rail: sent, delivered, acked, tools, answered, returned. Done
 * steps are solid, the one being waited on carries the accent, a failure is red, an
 * optional step that was passed over (no tools) is a hollow ring, and tools waiting for the
 * member to allow access (M4 §2) are amber.
 */
export function StepTrack({ steps, className }: { steps: Step[]; className?: string }) {
  const label = steps.map((s) => stepTitle(s)).join('; ')
  return (
    <div role="img" aria-label={label} className={cn('flex items-center', className)}>
      {steps.map((s, i) => {
        const prev = steps[i - 1]
        const railDone = prev !== undefined && s.state !== 'upcoming' && prev.state !== 'upcoming'
        return (
          <span key={s.key} className="flex items-center" data-step={s.key} data-state={s.state} title={stepTitle(s)}>
            {i > 0 ? (
              <span
                aria-hidden
                className={cn('h-px w-2.5 sm:w-3.5', railDone ? 'bg-subtle/60' : 'bg-border')}
              />
            ) : null}
            <span
              aria-hidden
              className={cn(
                'block rounded-full',
                s.state === 'done' && 'size-[7px] bg-subtle',
                s.state === 'current' && 'step-wait size-[9px] bg-signal',
                s.state === 'failed' && 'size-[9px] bg-bad',
                s.state === 'waiting' && 'grant-wait size-[9px] bg-warn',
                s.state === 'skipped' && 'size-[7px] border border-dashed border-faint',
                s.state === 'upcoming' && 'size-[7px] border border-border bg-card',
              )}
            />
          </span>
        )
      })}
    </div>
  )
}
