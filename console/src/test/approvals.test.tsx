import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import { App } from '@/App'
import { DIRECTORY_INTERVAL_MS } from '@/hooks/queries'
import { approvalsLine } from '@/lib/waiting'
import { fixtureActivity, fixtureDirectory, fixtureMe, FIXTURE_NOW } from '@/mock/fixtures'
import { renderWithClient } from './render'

// M8 §5: the local console's header says how many answers wait for the viewer's approval in
// their channel working session (from /api/approvals/summary, which only the local console
// server answers).

const KEY = 'k3yk3yk3yk3yk3yk3yk3yk3yk3yk3yk3'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function server(approvals: () => Response) {
  const paths: string[] = []
  setTransport(async (path) => {
    paths.push(path)
    const url = new URL(path, 'http://console.invalid/')
    if (url.pathname === '/api/me') return json(fixtureMe)
    if (url.pathname === '/api/directory') return json(fixtureDirectory)
    if (url.pathname === '/api/activity') return json(fixtureActivity)
    if (url.pathname === '/api/approvals/summary') return approvals()
    return json({ error: 'not_found' }, 404)
  })
  return { calls: () => paths.filter((p) => p === 'api/approvals/summary').length }
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const header = () => document.querySelector('header') as HTMLElement

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(new Date(FIXTURE_NOW))
  setConsoleKey(KEY)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('answers waiting for your approval (M8 §5)', () => {
  it('the line counts answers, singular and plural, and nothing for none', () => {
    expect(approvalsLine({ pending: 1 })).toBe('1 answer waiting for your approval')
    expect(approvalsLine({ pending: 3 })).toBe('3 answers waiting for your approval')
    expect(approvalsLine({ pending: 0 })).toBeNull()
    expect(approvalsLine(undefined)).toBeNull()
    expect(approvalsLine({ pending: -1 })).toBeNull()
  })

  it('shows the count in the header and follows it', async () => {
    let pending = 2
    server(() => json({ pending }))
    renderWithClient(<App />)
    await flush(10)
    expect(header().querySelector('[data-approvals-waiting]')).toHaveTextContent('2 answers waiting for your approval')
    pending = 0
    await flush(DIRECTORY_INTERVAL_MS + 10)
    expect(header().querySelector('[data-approvals-waiting]')).toBeNull()
  })

  it('the hosted console (no route, 404) shows nothing and is not asked again', async () => {
    const s = server(() => json({ error: 'not_found' }, 404))
    renderWithClient(<App />)
    await flush(10)
    expect(header().querySelector('[data-approvals-waiting]')).toBeNull()
    const calls = s.calls()
    await flush(3 * DIRECTORY_INTERVAL_MS)
    expect(s.calls()).toBe(calls)
  })
})
