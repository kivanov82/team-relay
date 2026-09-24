import { useCallback, useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'team-relay-console.theme'

function readChoice(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // Storage can be unavailable; the system preference is a fine default.
  }
  return 'system'
}

function systemDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applyTheme(choice: ThemeChoice = readChoice()): void {
  const dark = choice === 'dark' || (choice === 'system' && systemDark())
  document.documentElement.classList.toggle('dark', dark)
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice)

  useEffect(() => {
    applyTheme(choice)
    if (choice !== 'system' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [choice])

  const cycle = useCallback(() => {
    setChoice((c) => {
      const next: ThemeChoice = c === 'system' ? 'light' : c === 'light' ? 'dark' : 'system'
      try {
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // Not persisted; it still applies for this visit.
      }
      return next
    })
  }, [])

  return { choice, cycle }
}
