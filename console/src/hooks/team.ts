import { createContext, useContext } from 'react'

// The team the console is showing (M9 §5), or null for a console server that serves one team
// only (no /api/teams): then no X-Relay-Team is sent and the server's own team is read.
export const TeamContext = createContext<string | null>(null)

export function useTeam(): string | null {
  return useContext(TeamContext)
}

export type ConsoleView = 'team' | 'admin'

/** What the header and the pages need to move between teams and views (M9 §5). */
export interface Nav {
  /** The viewer's teams, or null for a console server that serves one team only. */
  teams: import('@/api/types').Teams | null
  team: string | null
  selectTeam: (team: string) => void
  view: ConsoleView
  setView: (view: ConsoleView) => void
  openCreate: () => void
}

export const NavContext = createContext<Nav>({
  teams: null,
  team: null,
  selectTeam: () => {},
  view: 'team',
  setView: () => {},
  openCreate: () => {},
})

export function useNav(): Nav {
  return useContext(NavContext)
}
