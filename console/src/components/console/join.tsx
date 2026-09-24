import { Check, ChevronRight, Copy, UserPlus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { useJoin, useMe } from '@/hooks/queries'
import { EMAIL_PLACEHOLDER, MIN_CLAUDE_CODE, MIN_NODE, joinCommands, viewerEmail } from '@/lib/join'
import { cn } from '@/lib/utils'

// "Join the team": the three steps of M5 §1 (install the plugin, sign in, start answering),
// with every value from GET /api/join and the viewer's email from /api/me, and, for an owner,
// how to invite someone (M6 §4). A disclosure: open on a viewer's first visit, closed on later
// ones, and after that as the viewer left it.

export const JOIN_STORAGE_KEY = 'team-relay-console.join'

type Stored = 'open' | 'closed'

function readStored(): Stored | null {
  try {
    const v = window.localStorage.getItem(JOIN_STORAGE_KEY)
    return v === 'open' || v === 'closed' ? v : null
  } catch {
    return null
  }
}

function writeStored(v: Stored): void {
  try {
    window.localStorage.setItem(JOIN_STORAGE_KEY, v)
  } catch {
    // Storage can be unavailable; the panel still opens and closes for this visit.
  }
}

function useRemembered(): [boolean, () => void] {
  // First visit (nothing stored, or no storage at all): open.
  const [open, setOpen] = useState(() => readStored() !== 'closed')
  useEffect(() => {
    // Seen once: the next visit starts closed unless the viewer opens it again.
    if (readStored() === null) writeStored('closed')
  }, [])
  const toggle = useCallback(() => {
    const next = !open
    writeStored(next ? 'open' : 'closed')
    setOpen(next)
  }, [open])
  return [open, toggle]
}

const COPIED_MS = 1600

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  const copy = async () => {
    let next: 'copied' | 'failed'
    try {
      await navigator.clipboard.writeText(text)
      next = 'copied'
    } catch {
      next = 'failed'
    }
    setState(next)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), COPIED_MS)
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`Copy ${label}`}
      data-copy={state}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-subtle transition-colors hover:bg-card hover:text-foreground',
        state === 'copied' && 'text-ok hover:text-ok',
        state === 'failed' && 'text-bad hover:text-bad',
        className,
      )}
    >
      {state === 'copied' ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
      <span aria-live="polite" className={cn(state === 'idle' && 'sr-only')}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </button>
  )
}

function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex min-w-0 items-start gap-1 rounded-md border bg-muted/60 py-1 pr-1 pl-3" data-command={label}>
      <pre className="min-w-0 flex-1 py-0.5 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
        <code>{text}</code>
      </pre>
      <CopyButton text={text} label={label} />
    </div>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px] text-foreground">{children}</code>
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex break-inside-avoid gap-3 pb-5" data-step={n}>
      <span
        aria-hidden
        className="tnum mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium text-subtle"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <h3 className="text-[13px] leading-5 font-semibold">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[12.5px] leading-relaxed text-subtle">{children}</p>
}

function Steps({ owner }: { owner: boolean }) {
  const join = useJoin()
  const me = useMe()

  if (join.isPending) {
    return (
      <div className="flex flex-col gap-3 pb-4" aria-label="Loading the join steps">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-8 w-full max-w-xl" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    )
  }
  if (!join.data) {
    return (
      <p className="pb-4 text-[12.5px] text-subtle">
        The join details did not load. Reload the page, or ask the team owner how to join.
      </p>
    )
  }

  const email = viewerEmail(me.data?.email)
  const c = joinCommands(join.data)

  return (
    <div className="flex flex-col gap-4">
      {owner ? (
        <p
          data-invite-hint
          className="flex items-start gap-2 rounded-md border bg-muted/60 px-3 py-2 text-[12.5px] leading-relaxed"
        >
          <UserPlus aria-hidden className="mt-0.5 size-3.5 shrink-0 text-subtle" />
          <span>
            <span className="font-medium">Inviting someone?</span> Add their Google email{' '}
            <button
              type="button"
              className="rounded font-medium text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal"
              onClick={() => document.getElementById('members-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              here
            </button>
            , then send them the install steps.
          </span>
        </p>
      ) : null}
      <ol className="gap-x-10 lg:columns-3" aria-label="Steps to join the team">
        <Step n={1} title="Install the plugin">
          {c.marketplaceAdd ? (
            <Command text={c.marketplaceAdd} label="marketplace command" />
          ) : (
            <Note>
              <span className="text-foreground">Ask the team owner where to add the plugin from.</span> Then add that
              marketplace.
            </Note>
          )}
          <Command text={c.install} label="install command" />
          <Note>No questions to answer. Then start Claude Code with the team channel:</Note>
          <Command text={c.working} label="working session command" />
          <Note>
            Claude Code {MIN_CLAUDE_CODE} or newer and Node.js {MIN_NODE} or newer. It asks once for consent to load the
            channel.
            {c.namesRelay ? (
              <>
                {' '}
                <Code>RELAY_URL</Code> points it at your team&apos;s relay; keep it there each time you start Claude Code.
              </>
            ) : null}
          </Note>
        </Step>

        <Step n={2} title="Sign in">
          <Command text={c.login} label="sign-in command" />
          <Note>
            Your browser opens on the relay. Sign in with Google
            {email !== EMAIL_PLACEHOLDER ? (
              <>
                {' '}
                as <span className="text-foreground">{email}</span>
              </>
            ) : (
              ' with the account the owner added'
            )}
            , pick the team, and you are connected.
          </Note>
        </Step>

        <Step n={3} title="Start answering">
          <Command text={c.answering} label="answering command" />
          <Note>It prints the one command that starts your answering session. Run that in a second terminal.</Note>
          <div data-reads className="flex flex-col gap-1.5">
            <Note>
              <span className="text-foreground">It reads none of your files by default.</span> To share folders, start it
              with <Code>ANSWERER_READ_DIRS=~/src/app:~/notes</Code> in front (teammates see the folder names). For anything
              else it asks you in that terminal. Credentials are never readable; these are Claude Code permission rules, not
              an OS sandbox.
            </Note>
            <Note>
              <Code>{c.console}</Code> opens this console on your own machine.
            </Note>
          </div>
        </Step>
      </ol>
    </div>
  )
}

export function JoinPanel({ owner = false }: { owner?: boolean }) {
  const [open, toggle] = useRemembered()
  return (
    <section
      aria-labelledby="join-title"
      className="flex min-w-0 flex-col rounded-xl border bg-card shadow-[0_1px_0_0_var(--hairline)]"
      data-join={open ? 'open' : 'closed'}
    >
      <h2 id="join-title" className="text-[13px] font-semibold tracking-[-0.005em]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="join-steps"
          onClick={toggle}
          className={cn(
            'flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-muted/50',
            open ? 'rounded-t-xl' : 'rounded-xl',
          )}
        >
          <ChevronRight
            aria-hidden
            className={cn('size-4 shrink-0 text-subtle transition-transform motion-reduce:transition-none', open && 'rotate-90')}
          />
          Join the team
          <span className="ml-auto hidden text-[12px] font-normal text-subtle sm:inline">
            Install, sign in, start answering
          </span>
        </button>
      </h2>
      <div id="join-steps" hidden={!open} className="border-t border-hairline px-4 pt-4">
        {open ? <Steps owner={owner} /> : null}
      </div>
    </section>
  )
}
