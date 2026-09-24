// Session presence from a last_seen timestamp (M2 §3.1, §5): online under 45 s, idle
// under 5 minutes, offline otherwise (and when the session has never been seen).

import { ms } from './time'

export type Presence = 'online' | 'idle' | 'offline'

export const ONLINE_MS = 45_000
export const IDLE_MS = 5 * 60_000

export function presenceOf(lastSeen: string | null | undefined, now: number): Presence {
  const t = ms(lastSeen)
  if (t === null) return 'offline'
  const age = now - t
  if (age < ONLINE_MS) return 'online'
  if (age < IDLE_MS) return 'idle'
  return 'offline'
}

export const PRESENCE_LABEL: Record<Presence, string> = {
  online: 'Online',
  idle: 'Idle',
  offline: 'Offline',
}
