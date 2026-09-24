import { Check, ChevronRight, Copy } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { useJoin, useMe } from '@/hooks/queries'
import { CLONE_PATH, EMAIL_PLACEHOLDER, MIN_CLAUDE_CODE, MIN_NODE, joinCommands, viewerEmail } from '@/lib/join'
import { cn } from '@/lib/utils'

// "Join the team": a reference panel of the steps a new member follows (plugin/README.md),
// with every value from GET /api/join and the viewer's email from /api/me. A disclosure:
// open on a viewer's first visit, closed on later ones, and after that as the viewer left it.

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

function Steps() {
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
  const placeholder = email === EMAIL_PLACEHOLDER
  const c = joinCommands(join.data, email)

  return (
    <ol className="gap-x-10 lg:columns-2" aria-label="Steps to join the team">
      <Step n={0} title="What you need">
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12.5px] leading-relaxed marker:text-faint">
          <li>Claude Code {MIN_CLAUDE_CODE} or newer</li>
          <li>Node.js {MIN_NODE} or newer</li>
          <li>The Google Cloud CLI</li>
          <li>Your team email on the relay's allowlist (ask the owner to add you)</li>
        </ul>
      </Step>

      <Step n={1} title="Sign in to Google Cloud as yourself">
        <Command text={c.signIn} label="sign-in command" />
        {placeholder ? <Note>Use your team email, the one on the allowlist.</Note> : null}
      </Step>

      <Step n={2} title="Get the plugin">
        {c.clone ? (
          <Command text={c.clone} label="clone command" />
        ) : (
          <Note>
            <span className="text-foreground">Ask the team owner for access to the team-relay repository.</span> Then
            clone it.
          </Note>
        )}
        <Note>
          The steps below use the clone's full path, shown as <Code>{CLONE_PATH}</Code>.
        </Note>
      </Step>

      <Step n={3} title="Install it in Claude Code">
        <Command text={c.marketplaceAdd} label="marketplace command" />
        <Command text={c.install} label="install command" />
        <Note>Answer the install questions with:</Note>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 rounded-md border py-1 pr-1 pl-3 font-mono text-[12px]">
          {c.answers.map((a) => (
            <div key={a.key} className="contents" data-answer={a.key}>
              <dt className="text-subtle">{a.key}</dt>
              <dd className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-foreground" title={a.value}>
                  {a.value}
                </span>
                <CopyButton text={a.value} label={`${a.key} value`} />
              </dd>
            </div>
          ))}
        </dl>
      </Step>

      <Step n={4} title="Start your working session">
        <Command text={c.working} label="working session command" />
        <Note>Claude Code asks once for consent to load the development channel.</Note>
      </Step>

      <Step n={5} title="Start your answering session">
        <Note>In a second terminal:</Note>
        <Command text={c.answering} label="answering session commands" />
        <Note>
          The first run asks you to log in once, in the session's own config (Vertex settings in your environment work
          too). To offer a capability, also export <Code>CAP_&lt;NAME&gt;_ENABLED=true</Code> and{' '}
          <Code>CAP_&lt;NAME&gt;_RUNNER</Code>; plugin/README.md has the details.
        </Note>
        <div data-reads className="flex flex-col gap-1.5">
          <Note>
            <span className="text-foreground">It reads none of your files by default.</span> To let it read a folder
            without asking, share it deliberately before you start: <Code>export ANSWERER_READ_DIRS=~/src/app:~/notes</Code>{' '}
            (teammates see the folder names).
          </Note>
          <Note>
            For anything else it asks you in that terminal, naming the file or folder: allow it once, for the session, or
            deny it. A desktop notification tells you when it is waiting.
          </Note>
          <Note>
            Credentials and keys are never readable, whatever you allow. These are Claude Code permission rules, not an
            OS sandbox.
          </Note>
        </div>
      </Step>

      <Step n={6} title="Check that it worked">
        <Note>
          Your two presence rings on the team map turn green within a minute. Then ask a teammate something from your
          working session.
        </Note>
      </Step>
    </ol>
  )
}

export function JoinPanel() {
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
            Install the plugin and start your two sessions
          </span>
        </button>
      </h2>
      <div id="join-steps" hidden={!open} className="border-t border-hairline px-4 pt-4">
        {open ? <Steps /> : null}
      </div>
    </section>
  )
}
