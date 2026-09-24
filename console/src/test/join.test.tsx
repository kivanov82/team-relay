// The "Join the team" panel: a disclosure that is open on a viewer's first visit and closed
// afterwards (remembered in localStorage, and fine without it), whose commands are built from
// GET /api/join and the viewer's email, with a copy button on every command.

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
  marketplace: 'zeta-market',
  plugin: 'zeta-relay',
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
    await screen.findByText('Sign in to Google Cloud as yourself')
    expect(window.localStorage.getItem(JOIN_STORAGE_KEY)).toBe('closed')
    first.unmount()

    renderWithClient(<JoinPanel />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(steps()).not.toBeVisible()
    expect(screen.queryByText('Sign in to Google Cloud as yourself')).toBeNull()
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
    await screen.findByText('Start your answering session')
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
    expect(await screen.findByText('Get the plugin')).toBeInTheDocument()
    expect(commandText('install command')).toBe('/plugin install zeta-relay@zeta-market')
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(get).toHaveBeenCalled()
    expect(set).toHaveBeenCalled()
  })
})

describe('join panel: the steps', () => {
  it('builds every command from /api/join and the viewer email', async () => {
    server()
    renderWithClient(<JoinPanel />)
    await screen.findByText('Sign in to Google Cloud as yourself')
    await waitFor(() => expect(commandText('sign-in command')).toBe('gcloud auth login dana@team.example'))

    expect(commandText('clone command')).toBe('git clone https://git.team.example/zeta/multiagent.git team-relay')
    expect(commandText('marketplace command')).toBe('/plugin marketplace add /path/to/team-relay')
    expect(commandText('install command')).toBe('/plugin install zeta-relay@zeta-market')
    expect(commandText('working session command')).toBe('claude --dangerously-load-development-channels plugin:zeta-relay@zeta-market')
    expect(commandText('answering session commands')).toBe(
      [
        'export RELAY_URL=https://relay-zeta.team.example',
        'export RELAY_TEAM=zeta',
        'export RELAY_GCLOUD_ACCOUNT=dana@team.example',
        '/path/to/team-relay/plugin/bin/answerer',
      ].join('\n'),
    )
    const answers = Object.fromEntries(
      [...document.querySelectorAll('[data-answer]')].map((el) => [
        el.getAttribute('data-answer'),
        el.querySelector('dd')?.textContent,
      ]),
    )
    expect(answers).toEqual({
      relay_url: 'https://relay-zeta.team.example',
      relay_team: 'zeta',
      relay_auth: 'google',
      gcloud_account: 'dana@team.example',
    })
    expect(screen.queryByText(/Ask the team owner for access/)).toBeNull()
    expect(screen.queryByText(/Use your team email/)).toBeNull()

    // Step 0 to step 6, in order, and the prerequisites.
    expect([...document.querySelectorAll('[data-step]')].map((el) => el.getAttribute('data-step'))).toEqual(['0', '1', '2', '3', '4', '5', '6'])
    expect(steps()).toHaveTextContent('Claude Code 2.1.280 or newer')
    expect(steps()).toHaveTextContent('Node.js 22 or newer')
    expect(steps()).toHaveTextContent('The Google Cloud CLI')
    expect(steps()).toHaveTextContent(/allowlist \(ask the owner to add you\)/)
    expect(steps()).toHaveTextContent(/presence rings on the team map turn green within a minute/)
    expect(steps()).toHaveTextContent(/CAP_<NAME>_ENABLED=true/)
    // Nothing from the demo leaks in.
    expect(steps()).not.toHaveTextContent(/relay\.example\.com|team-relay-dev|demo/)
    // Every command block has its own copy button.
    for (const block of document.querySelectorAll('[data-command]')) {
      expect(within(block as HTMLElement).getByRole('button', { name: /^Copy / })).toBeInTheDocument()
    }
  })

  it('says in step 5 what the answering session may read (M4 §4)', async () => {
    server()
    renderWithClient(<JoinPanel />)
    await screen.findByText('Start your answering session')
    await waitFor(() => expect(document.querySelector('[data-reads]')).not.toBeNull())
    const step5 = document.querySelector('[data-step="5"]') as HTMLElement
    const reads = step5.querySelector('[data-reads]') as HTMLElement
    // Nothing by default; share folders deliberately; grant when asked; never credentials; not a sandbox.
    expect(reads).toHaveTextContent('It reads none of your files by default.')
    expect(reads).toHaveTextContent(/share it deliberately before you start: export ANSWERER_READ_DIRS=~\/src\/app:~\/notes/)
    expect(reads).toHaveTextContent(/teammates see the folder names/)
    expect(reads).toHaveTextContent(/it asks you in that terminal, naming the file or folder: allow it once, for the session, or deny it/)
    expect(reads).toHaveTextContent(/desktop notification tells you when it is waiting/)
    expect(reads).toHaveTextContent(/Credentials and keys are never readable, whatever you allow/)
    expect(reads).toHaveTextContent(/permission rules, not an OS sandbox/)
    // The read setting is optional: the command block itself does not set it.
    expect(commandText('answering session commands')).not.toContain('ANSWERER_READ_DIRS')
  })

  it('uses a placeholder, and says which email, when /api/me gives none', async () => {
    const { email: _email, ...noEmail } = ME
    server({ me: noEmail })
    renderWithClient(<JoinPanel />)
    await screen.findByText('Sign in to Google Cloud as yourself')
    await waitFor(() => expect(commandText('sign-in command')).toBe('gcloud auth login <you>@<domain>'))
    expect(commandText('answering session commands')).toContain('export RELAY_GCLOUD_ACCOUNT=<you>@<domain>')
    expect(screen.getByText(/Use your team email/)).toBeInTheDocument()
  })

  it('asks the owner for the repository when repo_url is null', async () => {
    server({ join: { ...JOIN, repo_url: null } })
    renderWithClient(<JoinPanel />)
    expect(await screen.findByText('Ask the team owner for access to the team-relay repository.')).toBeInTheDocument()
    expect(command('clone command')).toBeNull()
    expect(steps()).not.toHaveTextContent('git clone')
    expect(commandText('install command')).toBe('/plugin install zeta-relay@zeta-market')
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
    await screen.findByText('Sign in to Google Cloud as yourself')
    await waitFor(() => expect(commandText('answering session commands')).toContain('dana@team.example'))

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const button = within(command('answering session commands')!).getByRole('button', { name: 'Copy answering session commands' })
    await act(async () => {
      fireEvent.click(button)
    })
    expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(clipboard.writeText).toHaveBeenCalledWith(commandText('answering session commands'))
    expect(button).toHaveTextContent('Copied')
    expect(button).toHaveAttribute('data-copy', 'copied')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(button).not.toHaveTextContent('Copied')
    expect(button).toHaveAttribute('data-copy', 'idle')

    const relayValue = within(document.querySelector('[data-answer="relay_url"]') as HTMLElement).getByRole('button')
    await act(async () => {
      fireEvent.click(relayValue)
    })
    expect(clipboard.writeText).toHaveBeenLastCalledWith('https://relay-zeta.team.example')
  })

  it('says the copy failed when the clipboard refuses, or there is none', async () => {
    clipboard.writeText.mockRejectedValue(new DOMException('no', 'NotAllowedError'))
    server()
    renderWithClient(<JoinPanel />)
    await screen.findByText('Sign in to Google Cloud as yourself')
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
    await screen.findByText('Sign in to Google Cloud as yourself')
    const panel = document.querySelector('[data-join]') as HTMLElement
    const header = screen.getAllByRole('banner')[0]!
    const map = document.getElementById('team-map-title')!.closest('section')!
    expect(header.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(panel.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(s.joinCalls()).toHaveLength(1)
  })
})
