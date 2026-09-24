import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ActivityRecipient, ActivityRequest, ProgressEntry } from '@/api/types'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useRequestDetail } from '@/hooks/queries'
import { elapsedMs, isOpen, phaseTone, summarize } from '@/lib/activity'
import { deriveTrack, PHASE_LABEL, type Step } from '@/lib/steps'
import { formatClock, formatDayClock, formatDuration, ms } from '@/lib/time'
import { cn } from '@/lib/utils'
import { KindIcon } from './activity'
import { Avatar, EnvBadge, Masked, StatusPill } from './primitives'

const PREVIEW_LIMIT = 2000

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12px] font-semibold">{title}</h3>
        {aside ? <div className="ml-auto text-[11.5px] text-subtle">{aside}</div> : null}
      </div>
      {children}
    </section>
  )
}

function Params({ params }: { params: Record<string, unknown> }) {
  const entries = Object.entries(params)
  if (entries.length === 0) return <p className="text-[12.5px] text-subtle">No parameters.</p>
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border bg-canvas px-3 py-2 font-mono text-[12px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-subtle">{k}</dt>
          <dd className="break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

function Timeline({ steps, req, r }: { steps: Step[]; req: ActivityRequest; r: ActivityRecipient }) {
  const due = (key: Step['key']): string | null => {
    if (key === 'acked' && r.status === 'pending') return `due ${formatClock(ms(req.ack_deadline) ?? 0)}`
    if (key === 'acked' && r.status === 'no_response') return `was due ${formatClock(ms(req.ack_deadline) ?? 0)}`
    if (key === 'answered' && r.status === 'acked') return `due ${formatClock(ms(req.answer_deadline) ?? 0)}`
    if (key === 'answered' && r.status === 'timed_out') return `was due ${formatClock(ms(req.answer_deadline) ?? 0)}`
    return null
  }
  return (
    <ol className="relative flex flex-col">
      {steps.map((s, i) => {
        const last = i === steps.length - 1
        const d = due(s.key)
        return (
          <li key={s.key} className="relative grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 py-[5px]" data-step={s.key} data-state={s.state}>
            {!last ? (
              <span
                aria-hidden
                className={cn(
                  'absolute top-[17px] left-[6.5px] h-[calc(100%-10px)] w-px',
                  s.state === 'done' && steps[i + 1]?.state !== 'upcoming' ? 'bg-subtle/50' : 'bg-border',
                )}
              />
            ) : null}
            <span className="relative flex size-3.5 items-center justify-center">
              <span
                className={cn(
                  'block rounded-full',
                  s.state === 'done' && 'size-2 bg-subtle',
                  s.state === 'current' && 'step-wait size-2.5 bg-signal',
                  s.state === 'failed' && 'size-2.5 bg-bad',
                  s.state === 'skipped' && 'size-2 border border-dashed border-faint',
                  s.state === 'upcoming' && 'size-2 border border-border bg-card',
                )}
              />
            </span>
            <span className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
              <span className={cn('truncate', s.state === 'upcoming' || s.state === 'skipped' ? 'text-subtle' : 'text-foreground')}>{s.label}</span>
              {s.state === 'current' ? <span className="text-[11.5px] text-signal">waiting</span> : null}
              {s.state === 'failed' ? <span className="text-[11.5px] text-bad">missed</span> : null}
              {s.state === 'skipped' ? <span className="text-[11.5px] text-faint">none used</span> : null}
            </span>
            <span className="tnum flex items-baseline gap-3 text-right text-[12px]">
              {s.hopMs !== null ? <span className="text-subtle">+{formatDuration(s.hopMs)}</span> : null}
              {s.at !== null ? (
                <span className="w-[4.6rem] text-foreground">{formatClock(s.at)}</span>
              ) : d ? (
                <span className="text-subtle">{d}</span>
              ) : (
                <span className="w-[4.6rem] text-faint">–</span>
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function ToolTable({ r, ackedAt }: { r: ActivityRecipient; ackedAt: number | null }) {
  if (r.tools.length === 0) return <p className="text-[12.5px] text-subtle">No tools used.</p>
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="text-left text-[11px] text-faint">
          <th className="pb-1 font-normal">Tool</th>
          <th className="pb-1 font-normal">Outcome</th>
          <th className="pb-1 text-right font-normal">Duration</th>
          <th className="pb-1 text-right font-normal">At</th>
        </tr>
      </thead>
      <tbody className="tnum">
        {r.tools.map((t, i) => {
          const at = ms(t.at)
          return (
            <tr key={`${t.tool}-${i}`} className="border-t border-hairline" data-tool={t.tool} data-status={t.status}>
              <td className="py-1.5 pr-2 font-mono text-[11.5px]">{t.tool}</td>
              <td className="py-1.5 pr-2">
                {t.status === 'ok' ? (
                  <span className="inline-flex items-center gap-1 text-ok">
                    <Check aria-hidden className="size-3.5" /> OK
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-bad">
                    <X aria-hidden className="size-3.5" /> Error
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-2 text-right">{t.duration_ms === null ? '–' : formatDuration(t.duration_ms)}</td>
              <td className="py-1.5 text-right text-subtle">
                {at === null ? '–' : ackedAt !== null ? `+${formatDuration(at - ackedAt)}` : formatClock(at)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Progress({ r, entries }: { r: ActivityRecipient; entries: ProgressEntry[] | null }) {
  const notes = (entries ?? []).filter((p) => (p.kind ?? 'progress') === 'progress')
  if (r.progress_count === 0 && notes.length === 0) return null
  const pct = r.last_progress_pct
  return (
    <Section title="Progress" aside={<span className="tnum">{r.progress_count} update{r.progress_count === 1 ? '' : 's'}</span>}>
      {pct !== null ? (
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <progress value={pct} max={100} aria-label="Last reported progress" className="progress-bar block h-full w-full" />
          </div>
          <span className="tnum w-9 text-right text-[12px] text-subtle">{pct}%</span>
        </div>
      ) : null}
      {notes.length > 0 ? (
        <ol className="flex flex-col gap-1 text-[12px]">
          {notes.map((p) => (
            <li key={p.seq} className="grid grid-cols-[4.6rem_minmax(0,1fr)_auto] gap-2">
              <span className="tnum text-subtle">{formatClock(ms(p.time) ?? 0)}</span>
              <span className="break-words">{p.text}</span>
              <span className="tnum text-faint">{p.pct === null || p.pct === undefined ? '' : `${p.pct}%`}</span>
            </li>
          ))}
        </ol>
      ) : entries === null ? null : null}
    </Section>
  )
}

function RecipientDetail({
  req,
  member,
  r,
  me,
  progress,
}: {
  req: ActivityRequest
  member: string
  r: ActivityRecipient
  me: string | null
  progress: ProgressEntry[] | null
}) {
  const track = deriveTrack(req, r)
  const tone = phaseTone(track.phase)
  const preview = r.answer_preview
  return (
    <article className="flex flex-col gap-4 rounded-lg border bg-card p-4" data-recipient-detail={member}>
      <header className="flex items-center gap-2.5">
        <Avatar member={member} you={member === me} />
        <span className="text-[13.5px] font-semibold">{member === me ? `${member} (you)` : member}</span>
        <StatusPill tone={tone} className="ml-auto">
          {PHASE_LABEL[track.phase]}
        </StatusPill>
      </header>

      <Timeline steps={track.steps} req={req} r={r} />

      <Section title="Tools" aside={r.tools.length > 0 ? <span className="tnum">{r.tools.length} used</span> : undefined}>
        <ToolTable r={r} ackedAt={ms(r.acked_at)} />
      </Section>

      <Progress r={r} entries={progress === null ? null : progress.filter((p) => p.member === member)} />

      {r.status === 'answered' || preview !== null || !req.participant ? (
        <Section
          title="Answer"
          aside={preview !== null && preview.length >= PREVIEW_LIMIT ? 'First 2,000 characters' : undefined}
        >
          {!req.participant ? (
            <Masked what="the answer" />
          ) : preview !== null ? (
            <p className="rounded-md border bg-canvas px-3 py-2.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap">
              {preview}
            </p>
          ) : r.status === 'answered' && req.asker !== me && member !== me ? (
            // A co-recipient of a broadcast sees its own answer only; the relay withholds
            // the others' (M2 §7.8). There is an answer; it is just not ours to read.
            <Masked what="the answer" label="Only the asker sees this answer" />
          ) : (
            <p className="text-[12.5px] text-subtle">No answer yet.</p>
          )}
        </Section>
      ) : null}
    </article>
  )
}

export function RequestSheet({
  req: current,
  me,
  now,
  onClose,
}: {
  req: ActivityRequest | null
  me: string | null
  now: number
  onClose: () => void
}) {
  // Keep drawing the last request while the sheet animates closed.
  const [last, setLast] = useState<ActivityRequest | null>(current)
  if (current !== null && current !== last) setLast(current)
  const req = current ?? last
  const open = current !== null
  const live = req !== null && isOpen(req)
  // The side surface (M1 §3.11) answers participants only; a non-participant never asks.
  const detail = useRequestDetail(req?.request_id ?? null, open && req !== null && req.participant, open && live)

  useEffect(() => {
    if (!open) return
    document.documentElement.classList.add('overflow-hidden')
    return () => document.documentElement.classList.remove('overflow-hidden')
  }, [open])

  return (
    <Sheet open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto border-l bg-canvas p-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-[34rem]"
        // Focus the panel itself, not its close button: Tab reaches the button next, and
        // Escape closes the sheet from anywhere in it.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement | null)?.focus()
        }}
      >
        {req ? (
          <>
            <SheetHeader className="sticky top-0 z-10 gap-2 border-b bg-canvas/95 px-5 pt-4 pb-3 backdrop-blur-md">
              <div className="flex items-center gap-2 pr-8">
                <KindIcon req={req} />
                <SheetTitle className="text-[14px] font-semibold">
                  {req.kind === 'capability' ? 'Capability call' : req.broadcast ? 'Broadcast question' : 'Question'}
                </SheetTitle>
                <StatusPill tone={summarize(req).tone}>{summarize(req).label}</StatusPill>
              </div>
              <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                <span>
                  From <span className="text-foreground">{req.asker === me ? `${req.asker} (you)` : req.asker}</span> to{' '}
                  <span className="text-foreground">
                    {Object.keys(req.recipients)
                      .map((m) => (m === me ? `${m} (you)` : m))
                      .join(', ')}
                  </span>
                </span>
                <span className="tnum">{formatDayClock(ms(req.created_at) ?? 0)}</span>
                <span className="tnum">{formatDuration(elapsedMs(req, now))} elapsed</span>
              </SheetDescription>
              <code className="w-fit font-mono text-[11px] text-faint select-all">{req.request_id}</code>
            </SheetHeader>

            <div className="flex flex-col gap-5 px-5 py-5">
              {req.kind === 'capability' && req.capability ? (
                <Section title="Call">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px] font-medium">{req.capability.name}</span>
                    <EnvBadge environment={req.capability.environment} />
                  </div>
                  {req.capability.params === null ? <Masked what="the parameters" /> : <Params params={req.capability.params} />}
                </Section>
              ) : (
                <Section title="Question">
                  {req.question === null ? (
                    <Masked what="the question" />
                  ) : (
                    <p className="rounded-md border bg-card px-3 py-2.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap">
                      {req.question}
                    </p>
                  )}
                </Section>
              )}

              <Section title={Object.keys(req.recipients).length > 1 ? 'Recipients' : 'Recipient'}>
                <div className="flex flex-col gap-3">
                  {Object.entries(req.recipients).map(([m, r]) => (
                    <RecipientDetail key={m} req={req} member={m} r={r} me={me} progress={detail.data?.progress ?? null} />
                  ))}
                </div>
              </Section>

              <Section title="Deadlines">
                <dl className="tnum grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]">
                  <dt className="text-subtle">Acknowledge by</dt>
                  <dd>{formatDayClock(ms(req.ack_deadline) ?? 0)}</dd>
                  <dt className="text-subtle">Answer by</dt>
                  <dd>{formatDayClock(ms(req.answer_deadline) ?? 0)}</dd>
                  <dt className="text-subtle">Expires</dt>
                  <dd>{formatDayClock(ms(req.expire_at) ?? 0)}</dd>
                </dl>
              </Section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
