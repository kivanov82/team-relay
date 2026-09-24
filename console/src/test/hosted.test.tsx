// @vitest-environment-options {"url": "https://team-relay-console-abc123-ey.a.run.app/"}
//
// M3 §4: the hosted console, served from its Cloud Run host behind IAP. No key anywhere:
// the calls go without X-Console-Key and with the IAP session cookie, and an expired
// sign-in (a redirect to Google, or anything that is not the console server's JSON) shows
// the "session expired" screen instead of the key screens.

import { act, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getJson, setTransport } from '@/api/client'
import { consoleKey, isHosted } from '@/api/key'
import type { ActivityPage } from '@/api/types'
import { App } from '@/App'
import { fixtureActivity, fixtureDirectory, fixtureMe, FIXTURE_NOW } from '@/mock/fixtures'
import { renderWithClient, setHidden } from './render'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

/** What fetch hands back for a redirect under `redirect: 'manual'`. */
function opaqueRedirect(): Response {
  const res = new Response(null, { status: 200 })
  Object.defineProperty(res, 'type', { value: 'opaqueredirect' })
  Object.defineProperty(res, 'status', { value: 0 })
  Object.defineProperty(res, 'ok', { value: false })
  return res
}

const signInPage = (status = 200) =>
  new Response('<!doctype html><title>Sign in - Google Accounts</title>', { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })

interface Call {
  path: string
  init: RequestInit
}

function server(override?: (path: string) => Response | null) {
  const calls: Call[] = []
  setTransport(async (path, init) => {
    calls.push({ path, init })
    const forced = override?.(path)
    if (forced) return forced
    const url = new URL(path, 'http://console.invalid/')
    if (url.pathname === '/api/me') return json(fixtureMe)
    if (url.pathname === '/api/directory') return json(fixtureDirectory)
    if (url.pathname === '/api/activity') {
      const since = url.searchParams.get('since')
      return json(since === null ? fixtureActivity : ({ requests: [], next_since: since, server_time: FIXTURE_NOW } satisfies ActivityPage))
    }
    return json({ error: 'not_found' }, 404)
  })
  return calls
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('the hosted console (keyless)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(Date.parse(FIXTURE_NOW))
    setHidden(false)
  })

  afterEach(() => {
    setHidden(false)
  })

  it('is served from a non-loopback host and has no key', () => {
    expect(window.location.hostname).toBe('team-relay-console-abc123-ey.a.run.app')
    expect(isHosted()).toBe(true)
    expect(consoleKey()).toBeNull()
  })

  it('calls the API without a key, with the session cookie, never following a redirect, and shows the viewer', async () => {
    const calls = server()
    renderWithClient(<App />)
    await flush(10)

    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const c of calls) {
      const headers = new Headers(c.init.headers)
      expect(headers.has('X-Console-Key')).toBe(false)
      expect(c.init.credentials).toBe('same-origin')
      expect(c.init.redirect).toBe('manual')
      expect(c.init.method).toBe('GET')
    }
    expect(screen.queryByRole('heading', { name: 'Open the console from its link' })).toBeNull()
    const banner = screen.getAllByRole('banner')[0]!
    expect(banner).toHaveTextContent(`Team ${fixtureMe.team}`)
    expect(banner).toHaveTextContent(`${fixtureMe.member}(you)`)
    expect(screen.getByRole('status')).toHaveTextContent('Live')
  })

  it('shows the expired-session screen when IAP redirects to sign-in, and stops polling', async () => {
    let signedIn = true
    const calls = server(() => (signedIn ? null : opaqueRedirect()))
    renderWithClient(<App />)
    await flush(10)
    expect(screen.getByRole('status')).toHaveTextContent('Live')

    signedIn = false
    await flush(3_000)
    expect(screen.getByRole('heading', { name: 'Your session has expired' })).toBeInTheDocument()
    expect(screen.getByText('Reload to sign in again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'This console link is no longer valid' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Open the console from its link' })).toBeNull()

    const before = calls.filter((c) => c.path.startsWith('api/activity')).length
    await flush(30_000)
    expect(calls.filter((c) => c.path.startsWith('api/activity')).length).toBe(before)
  })

  it('shows it too when the first answer is a sign-in page rather than JSON', async () => {
    server(() => signInPage())
    renderWithClient(<App />)
    await flush(10)
    expect(screen.getByRole('heading', { name: 'Your session has expired' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reads every sign-in shape as an expired session', async () => {
    const cases: Array<[string, () => Response]> = [
      ['opaque redirect', opaqueRedirect],
      ['302 to Google', () => new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth' } })],
      ['200 sign-in page', () => signInPage(200)],
      ['401 from IAP', () => signInPage(401)],
      ['401 JSON without a key', () => json({ error: 'unauthenticated' }, 401)],
      ['403 JSON without a key', () => json({ error: 'forbidden' }, 403)],
      ['200 with a JSON type but not JSON', () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ]
    for (const [name, make] of cases) {
      setTransport(async () => make())
      const err = await getJson('api/me').catch((e: unknown) => e)
      expect(err, name).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind, name).toBe('session_expired')
    }
    // The console server's own answers keep their meaning.
    setTransport(async () => json({ error: 'relay_refused', relay_status: 500 }, 502))
    expect(((await getJson('api/me').catch((e: unknown) => e)) as ApiError).kind).toBe('relay_unreachable')
    setTransport(async () => json({ error: 'not_found' }, 404))
    expect(((await getJson('api/me').catch((e: unknown) => e)) as ApiError).kind).toBe('not_found')
  })
})
