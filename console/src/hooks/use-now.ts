import { useSyncExternalStore } from 'react'

// One shared one-second clock for every ticking label (elapsed times, "updated 2 s ago",
// presence), so the page re-renders once per second at most and not at all while hidden.

const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null

function tick() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  now = Date.now()
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (timer === null) {
    now = Date.now()
    timer = setInterval(tick, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => now)
}
