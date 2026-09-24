// The "Join the team" panel: a disclosure that is open on a viewer's first visit and closed
// afterwards (remembered in localStorage, and fine without it), with M5 §1's three steps
// (install the plugin, sign in, start answering) built from GET /api/join, a copy button on
// every command, and, for an owner, how to invite someone (M6 §4).

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import type { Join, Me } from '@/api/types'
import { App } from '@/App'
import { JOIN_STORAGE_KEY, JoinPanel } from '@/components/console/join'
import { fixtureActivity, fixtureDirectory, fixtureMe } from '@/mock/fixtures'
import { renderWithClient } from './render'

const KEY = 'j01nj01nj01nj01nj01nj01nj01nj01n'

// Deliberately not the demo values: nothing in the panel may be hardcoded.
const JOIN: Join = {
  relay_url: 'https://relay-zeta.team.example',
  team: 'zeta',
  repo_url: 'https://git.team.example/zeta/multiagent.git',
  marketplace_source: 'zeta-org/zeta-relay',
  marketplace: 'zeta-market',
  plugin: 'zeta-relay',
  default_relay: true,
}
const ME: Me = { team: 'zeta', member: 'dana', teammates: ['eli'], email: 'dana@team.example' }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function server(opts: { join?: Join | null; me?: Me } = {}) {
  const calls: string[] = []
  setTransport(async (path) => {
    calls.push(path)
    const url = new URL(path, 'http://console.invalid/')
    if (url.pathname === '/api/join') return opts.join === null ? json({ error: 'not_found' }, 404) : json(opts.join ?? JOIN)
    if (url.pathname === '/api/me') return json(opts.me ?? ME)
    if (url.pathname === '/api/directory') return json(fixtureDirectory)
    if (url.pathname === '/api/activity') return json(fixtureActivity)
    return json({ error: 'not_found' }, 404)
  })
  return { calls, joinCalls: () => calls.filter((c) => c === 'api/join') }
}

const toggle = () => screen.getByRole('button', { name: /Join the team/ })
const steps = () => document.getElementById('join-steps') as HTMLElement
const command = (label: string) => document.querySelector(`[data-command="${label}"]`) as HTMLElement | null
const commandText = (label: string) => command(label)?.querySelector('code')?.textContent ?? null

let clipboard: { writeText: ReturnType<typeof vi.fn> }

beforeEach(() => {
  setConsoleKey(KEY)
  window.localStorage.clear()
  clipboard = { writeText: vi.fn(async () => {}) }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
})

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
})

describe('join panel: open and closed', () => {
  it('is open on the first visit, and the next visit starts closed', async () => {
    const s = server()
    const first = renderWithClient(<JoinPanel />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(toggle()).toHaveAttribute('aria-controls', 'join-steps')
    expect(steps()).toBeVisible()
    await screen.findByText('Install the plugin')
    expect(window.localStorage.getItem(JOIN_STORAGE_KEY)).toBe('closed')
    first.unmount()

    renderWithClient(<JoinPanel />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(steps()).not.toBeVisible()
    expect(screen.queryByText('Install the plugin')).toBeNull()
    expect(s.joinCalls()).toHaveLength(1)
  })

  it('remembers what the viewer left it at', async () => {
    window.localStorage.setItem(JOIN_STORAGE_KEY, 'closed')
    server()
    const user = userEvent.setup()
    const a = renderWithClient(<JoinPanel />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(window.localStorage.getItem(JOIN_STORAGE_KEY)).toBe('open')
    await screen.findByText('Start answering')
    a.unmount()

    const b = renderWithClient(<JoinPanel />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(window.localStorage.getItem(JOIN_STORAGE_KEY)).toBe('closed')
    b.unmount()

    renderWithClient(<JoinPanel />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens and closes from the keyboard', async () => {
    window.localStorage.setItem(JOIN_STORAGE_KEY, 'closed')
    server()
    const user = userEvent.setup()
    renderWithClient(<JoinPanel />)
    await user.tab()
    expect(toggle()).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders, open, and still toggles when storage is unavailable', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    server()
    const user = userEvent.setup()
    renderWithClient(<JoinPanel />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('Sign in')).toBeInTheDocument()
    expect(commandText('install command')).toBe('/plugin install zeta-relay@zeta-market')
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(get).toHaveBeenCalled()
    expect(set).toHaveBeenCalled()
  })
})

describe('join panel: the steps (M5 §1)', () => {
  it('builds every command from /api/join: install, sign in, start answering', async () => {
    server()
    renderWithClient(<JoinPanel />)
    await screen.findByText('Install the plugin')
    expect([...document.querySelectorAll('[data-step]')].map((el) => el.getAttribute('data-step'))).toEqual(['1', '2', '3'])
    expect(screen.getByText('Sign in')).toBeInTheDocument()
    expect(screen.getByText('Start answering')).toBeInTheDocument()

    expect(commandText('marketplace command')).toBe('/plugin marketplace add zeta-org/zeta-relay')
    expect(commandText('install command')).toBe('/plugin install zeta-relay@zeta-market')
    expect(commandText('working session command')).toBe('claude --dangerously-load-development-channels plugin:zeta-relay@zeta-market')
    // The team's relay is the plugin's default: a bare login reaches it.
    expect(commandText('sign-in command')).toBe('/zeta-relay:login')
    expect(commandText('answering command')).toBe('/zeta-relay:answering')
    expect(steps()).toHaveTextContent('/zeta-relay:console')
    expect(steps()).toHaveTextContent('No questions to answer.')
    expect(steps()).toHaveTextContent('Claude Code 2.1.280 or newer and Node.js 22 or newer')
    await waitFor(() => expect(steps()).toHaveTextContent(/Sign in with Google as dana@team\.example, pick the team, and you are connected/))
    // No gcloud, no clone, no install questions, no environment to export.
    expect(steps()).not.toHaveTextContent(/gcloud|git clone|RELAY_URL|RELAY_TEAM|relay_auth|export /)
    // Nothing from the demo leaks in.
    expect(steps()).not.toHaveTextContent(/relay\.example\.com|team-relay-dev|demo/)
    // Every command block has its own copy button.
    for (const block of document.querySelectorAll('[data-command]')) {
      expect(within(block as HTMLElement).getByRole('button', { name: /^Copy / })).toBeInTheDocument()
    }
    // Not an owner: no invite hint.
    expect(document.querySelector('[data-invite-hint]')).toBeNull()
  })

  it('names a relay that is not the plugin default in the working session environment, never in the sign-in command', async () => {
    server({ join: { ...JOIN, default_relay: false } })
    renderWithClient(<JoinPanel />)
    await screen.findByText('Install the plugin')
    // M5-SPEC §9: the login command takes no relay URL; RELAY_URL is the only way to pick one.
    expect(commandText('working session command')).toBe(
      'RELAY_URL=https://relay-zeta.team.example claude --dangerously-load-development-channels plugin:zeta-relay@zeta-market',
    )
    expect(commandText('sign-in command')).toBe('/zeta-relay:login')
    expect(steps()).toHaveTextContent(/RELAY_URL points it at your team's relay/)
  })

  it('says in step 3 what the answering session may read (M4 §4)', async () => {
    server()
    renderWithClient(<JoinPanel />)
    await screen.findByText('Start answering')
    const step3 = document.querySelector('[data-step="3"]') as HTMLElement
    const reads = step3.querySelector('[data-reads]') as HTMLElement
    expect(reads).toHaveTextContent('It reads none of your files by default.')
    expect(reads).toHaveTextContent(/ANSWERER_READ_DIRS=~\/src\/app:~\/notes/)
    expect(reads).toHaveTextContent(/teammates see the folder names/)
    expect(reads).toHaveTextContent(/For anything else it asks you in that terminal/)
    expect(reads).toHaveTextContent(/Credentials are never readable/)
    expect(reads).toHaveTextContent(/permission rules, not an OS sandbox/)
    expect(commandText('answering command')).not.toContain('ANSWERER_READ_DIRS')
  })

  it('says which account to use when /api/me gives no email', async () => {
    const { email: _email, ...noEmail } = ME
    server({ me: noEmail })
    renderWithClient(<JoinPanel />)
    await screen.findByText('Install the plugin')
    await waitFor(() => expect(steps()).toHaveTextContent(/Sign in with Google with the account the owner added/))
  })

  it('asks the owner where to add the plugin from when there is no marketplace source', async () => {
    server({ join: { ...JOIN, marketplace_source: null } })
    renderWithClient(<JoinPanel />)
    expect(await screen.findByText('Ask the team owner where to add the plugin from.')).toBeInTheDocument()
    expect(command('marketplace command')).toBeNull()
    expect(commandText('install command')).toBe('/plugin install zeta-relay@zeta-market')
  })

  it('never puts an odd marketplace source or relay URL into a command', async () => {
    server({ join: { ...JOIN, marketplace_source: 'x; rm -rf ~', relay_url: 'https://relay.example.com/$(id)', default_relay: false } })
    renderWithClient(<JoinPanel />)
    await screen.findByText('Install the plugin')
    expect(command('marketplace command')).toBeNull()
    expect(commandText('sign-in command')).toBe('/zeta-relay:login')
    expect(commandText('working session command')).toBe('claude --dangerously-load-development-channels plugin:zeta-relay@zeta-market')
    expect(steps()).not.toHaveTextContent(/\$\(id\)/)
  })

  it('tells an owner how to invite someone (M6 §4)', async () => {
    server()
    renderWithClient(<JoinPanel owner />)
    await screen.findByText('Install the plugin')
    const hint = document.querySelector('[data-invite-hint]') as HTMLElement
    expect(hint).toHaveTextContent('Add their Google email here, then send them the install steps.')
    expect(within(hint).getByRole('button', { name: 'here' })).toBeInTheDocument()
  })

  it('says so when the join details do not load', async () => {
    server({ join: null })
    renderWithClient(<JoinPanel />)
    expect(await screen.findByText(/The join details did not load/)).toBeInTheDocument()
    expect(document.querySelectorAll('[data-command]')).toHaveLength(0)
  })
})

describe('join panel: copy', () => {
  it('writes the command to the clipboard and shows Copied for a moment', async () => {
    server()
    renderWithClient(<JoinPanel />)
    await screen.findByText('Install the plugin')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const button = within(command('sign-in command')!).getByRole('button', { name: 'Copy sign-in command' })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(clipboard.writeText).toHaveBeenCalledWith('/zeta-relay:login')
    expect(button).toHaveTextContent('Copied')
    expect(button).toHaveAttribute('data-copy', 'copied')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(button).not.toHaveTextContent('Copied')
    expect(button).toHaveAttribute('data-copy', 'idle')

    const answering = within(command('answering command')!).getByRole('button')
    await act(async () => {
      fireEvent.click(answering)
    })
    expect(clipboard.writeText).toHaveBeenLastCalledWith('/zeta-relay:answering')
  })

  it('says the copy failed when the clipboard refuses, or there is none', async () => {
    clipboard.writeText.mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    server()
    renderWithClient(<JoinPanel />)
    await screen.findByText('Install the plugin')
    const button = within(command('install command')!).getByRole('button')
    await act(async () => {
      fireEvent.click(button)
    })
    expect(button).toHaveTextContent('Copy failed')

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const other = within(command('working session command')!).getByRole('button')
    await act(async () => {
      fireEvent.click(other)
    })
    expect(other).toHaveTextContent('Copy failed')
  })
})

describe('join panel in the console', () => {
  it('sits below the header and above the team map, and does not depend on the relay', async () => {
    const s = server({ me: { ...fixtureMe } })
    renderWithClient(<App />)
    await screen.findByText('Install the plugin')
    const panel = document.querySelector('[data-join]') as HTMLElement
    const header = screen.getAllByRole('banner')[0]!
    const map = document.getElementById('team-map-title')!.closest('section')!
    expect(header.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(panel.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(s.joinCalls()).toHaveLength(1)
  })
})
