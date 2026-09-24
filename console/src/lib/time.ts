// Time helpers. Every duration the console shows goes through one formatter so that the
// same interval reads the same way in a row, on the map and in the detail sheet.

export function ms(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** 820 ms, 4.2 s, 38 s, 1m 12s, 2h 04m, 3d 4h. */
export function formatDuration(msValue: number): string {
  const v = Math.max(0, msValue)
  if (v < 1000) return `${Math.round(v)} ms`
  if (v < 10_000) return `${(Math.floor(v / 100) / 10).toFixed(1)} s`
  const s = Math.floor(v / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** A coarse "since" for presence and freshness: just now, 12 s ago, 3 min ago, 2 h ago. */
export function formatAgo(msValue: number): string {
  const s = Math.floor(Math.max(0, msValue) / 1000)
  if (s < 3) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

const dayClock = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 14:03:27, local time. */
export function formatClock(t: number): string {
  return clock.format(t)
}

/** 23 Sep, 14:03, local time. */
export function formatDayClock(t: number): string {
  return dayClock.format(t)
}
