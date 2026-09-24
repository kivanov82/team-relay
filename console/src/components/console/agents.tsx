import type { DirectoryMember } from '@/api/types'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PRESENCE_LABEL, presenceOf } from '@/lib/presence'
import { formatAgo, formatDuration, ms } from '@/lib/time'
import { cn } from '@/lib/utils'
import { Avatar, EnvBadge, Panel, PresenceDot } from './primitives'

function Session({ label, lastSeen, now }: { label: string; lastSeen: string | null; now: number }) {
  const p = presenceOf(lastSeen, now)
  const t = ms(lastSeen)
  return (
    <div className="flex min-w-0 items-center gap-2" data-session={label.toLowerCase()} data-presence={p}>
      <PresenceDot presence={p} />
      <span className="text-subtle">{label}</span>
      <span className={cn('tnum truncate', p === 'offline' ? 'text-faint' : 'text-foreground')}>
        {PRESENCE_LABEL[p]}
        {p !== 'online' && t !== null ? <span className="text-subtle">, {formatAgo(now - t)}</span> : null}
        {t === null ? <span className="text-subtle">, never seen</span> : null}
      </span>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[11px] text-subtle">{label}</dt>
      <dd className="tnum text-[13px] font-medium">{value}</dd>
    </div>
  )
}

export function AgentRow({ agent, now }: { agent: DirectoryMember; now: number }) {
  const caps = agent.manifest?.capabilities ?? []
  const published = ms(agent.published_at)
  return (
    <li className="flex flex-col gap-3 px-4 py-3.5" data-agent={agent.member}>
      <div className="flex items-center gap-2.5">
        <Avatar member={agent.member} />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold leading-tight">{agent.member}</div>
          <div className="text-[11.5px] text-subtle">
            {caps.length === 0
              ? 'Answers questions only'
              : `${caps.length} ${caps.length === 1 ? 'capability' : 'capabilities'}`}
            {published !== null ? <span className="tnum">, published {formatAgo(now - published)}</span> : null}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-1.5 text-[12px] min-[420px]:grid-cols-2">
        <Session label="Answering" lastSeen={agent.sessions.answering.last_seen} now={now} />
        <Session label="Working" lastSeen={agent.sessions.working.last_seen} now={now} />
      </div>

      {caps.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${agent.member}'s capabilities`}>
          {caps.map((c) => (
            <li key={c.name}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="inline-flex h-6 items-center gap-1.5 rounded-md border bg-canvas pr-1 pl-2 text-[11.5px]"
                  >
                    <span className="font-mono text-[11px]">{c.name}</span>
                    <EnvBadge environment={c.environment} />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-72 flex-col items-start gap-0.5">
                  <span className="font-medium">{c.title}</span>
                  <span className="opacity-80">{c.description}</span>
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="grid grid-cols-4 gap-2 rounded-lg bg-canvas px-3 py-2" aria-label="Last 24 hours">
        <Stat label="Asked" value={String(agent.stats.asked)} />
        <Stat label="Answered" value={String(agent.stats.answered)} />
        <Stat label="Open" value={String(agent.stats.open)} />
        <Stat
          label="Median"
          value={agent.stats.median_answer_seconds === null ? '–' : formatDuration(agent.stats.median_answer_seconds * 1000)}
        />
      </dl>
    </li>
  )
}

export function Agents({
  agents,
  loading,
  now,
  statsComplete = true,
  className,
}: {
  agents: DirectoryMember[]
  loading: boolean
  now: number
  /** The relay's stats covered only part of the 24 h window (M2 §7.10). */
  statsComplete?: boolean
  className?: string
}) {
  const online = agents.filter((a) => presenceOf(a.sessions.answering.last_seen, now) === 'online').length
  return (
    <Panel
      id="agents"
      title="Agents"
      className={className}
      aside={
        agents.length === 0 ? null : (
          <span className="tnum text-[12px] text-subtle">
            {online} of {agents.length} answering
            <span className="hidden sm:inline">{statsComplete ? ', stats for 24 h' : ', stats for 24 h (partial)'}</span>
          </span>
        )
      }
      bodyClassName="overflow-y-auto"
    >
      {loading ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : agents.length === 0 ? (
        <p className="px-4 py-6 text-[12.5px] text-subtle">
          No teammates have connected yet. They appear here once their plugin publishes a manifest.
        </p>
      ) : (
        <ul className="divide-y divide-hairline">
          {agents.map((a) => (
            <AgentRow key={a.member} agent={a} now={now} />
          ))}
        </ul>
      )}
    </Panel>
  )
}
