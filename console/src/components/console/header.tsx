import { Monitor, Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConnection, useMe } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { useTheme, type ThemeChoice } from '@/hooks/use-theme'
import { formatAgo, formatClock } from '@/lib/time'
import { cn } from '@/lib/utils'
import { Avatar, RelayMark } from './primitives'

const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'Theme follows the system',
  light: 'Light theme',
  dark: 'Dark theme',
}

function ThemeButton() {
  const { choice, cycle } = useTheme()
  const Icon = choice === 'light' ? Sun : choice === 'dark' ? Moon : Monitor
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={cycle} aria-label={`${THEME_LABEL[choice]}. Switch theme`}>
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{THEME_LABEL[choice]}</TooltipContent>
    </Tooltip>
  )
}

export function ConnectionStatus() {
  const conn = useConnection()
  const now = useNow()

  let dot = 'bg-faint'
  let label = 'Connecting'
  let detail: string | null = null
  if (conn.state === 'live') {
    dot = 'bg-ok'
    label = 'Live'
    detail = `Updated ${formatAgo(now - conn.updatedAt)}`
  } else if (conn.state === 'slowed') {
    dot = 'bg-warn'
    label = 'Slowed down'
    detail = conn.updatedAt !== null ? `Updated ${formatAgo(now - conn.updatedAt)}` : null
  } else if (conn.state === 'unreachable') {
    dot = 'bg-bad'
    label = conn.reason === 'relay' ? 'Relay unreachable' : 'Console server stopped'
    detail = conn.updatedAt ? `Last update ${formatClock(conn.updatedAt)}` : null
  } else if (conn.state === 'unauthorized') {
    dot = 'bg-bad'
    label = 'Link expired'
  } else if (conn.state === 'session_expired') {
    dot = 'bg-bad'
    label = 'Signed out'
  }

  return (
    <div className="flex min-w-0 items-center gap-3 text-[12px]" role="status" aria-live="polite">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span className="relative inline-flex size-2">
          {conn.state === 'live' && <span className="dot-pulse absolute inset-0 rounded-full bg-ok" />}
          <span className={cn('relative size-2 rounded-full', dot)} />
        </span>
        {conn.state === 'slowed' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="rounded text-foreground" data-connection="slowed">
                {label}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-64">
              The relay asked for fewer reads, so the console polls less often for a while. What is shown stays; updates
              resume on their own.
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className={cn(conn.state === 'unreachable' || conn.state === 'unauthorized' || conn.state === 'session_expired' ? 'text-bad' : 'text-foreground')}>
            {label}
          </span>
        )}
      </span>
      {conn.state === 'live' && conn.rttMs !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="tnum hidden rounded text-subtle sm:inline">
              {conn.rttMs} ms
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Round trip to the relay through the console server</TooltipContent>
        </Tooltip>
      ) : null}
      {detail ? <span className="tnum hidden text-subtle md:inline">{detail}</span> : null}
    </div>
  )
}

export function Header() {
  const me = useMe()
  return (
    <header className="sticky top-0 z-30 border-b bg-canvas/90 backdrop-blur-md supports-[backdrop-filter]:bg-canvas/75">
      <div className="mx-auto flex h-12 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <RelayMark />
          <span className="text-[13.5px] font-semibold tracking-[-0.01em]">Team relay</span>
        </div>
        {me.data ? (
          <div className="flex min-w-0 items-center gap-3 text-[12.5px]">
            <span aria-hidden className="h-4 w-px bg-border" />
            <span className="truncate">
              <span className="text-subtle">Team </span>
              <span className="font-medium">{me.data.team}</span>
            </span>
            <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
            <span className="hidden items-center gap-1.5 sm:inline-flex">
              <Avatar member={me.data.member} you size="sm" />
              <span className="font-medium">{me.data.member}</span>
              <span className="text-subtle">(you)</span>
            </span>
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <ConnectionStatus />
          <ThemeButton />
        </div>
      </div>
    </header>
  )
}
