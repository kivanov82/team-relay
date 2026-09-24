import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setTransport } from '@/api/client'
import { setConsoleKey } from '@/api/key'
import type { Directory, InboxSummary } from '@/api/types'
import { App } from '@/App'
import { DIRECTORY_INTERVAL_MS } from '@/hooks/queries'
import { agentWaiting, waitingLine } from '@/lib/waiting'
import { MockRelay } from '@/mock/relay'
import { fixtureActivity, fixtureDirectory, fixtureMe, FIXTURE_NOW } from '@/mock/fixtures'
import { renderWithClient, setHidden } from './render'

// M7 §3: "<n> waiting" on an agent card while that teammate's answering session is not
// running, and the viewer's own count in the header, from /api/inbox/summary.

const KEY = 'k3yk3yk3yk3yk3yk3yk3yk3yk3yk3yk3'
const NOW = Date.parse(FIXTURE_NOW)
const LONG_AGO = '2026-09-23T10:00:00.000Z'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function summary(p: Partial<InboxSummary> = {}): InboxSummary {
  return { pending: 2, more: false, oldest_at: LONG_AGO, from: ['bob', 'carol'], answering: { last_seen: null }, ...p }
}

/** bob's answering session is online with 2 waiting; carol's stopped with 3 waiting. */
function directory(): Directory {
  const dir = structuredClone(fixtureDirectory)
  dir.members[0]!.inbox_waiting = 2
  dir.members[1]!.inbox_waiting = 3
  dir.members[1]!.sessions.answering.last_seen = LONG_AGO
  return dir
}

function server(opts: { dir?: Directory; inbox?: () => Response } = {}) {
  const paths: string[] = []
  setTransport(async (path) => {
    paths.push(path)
    const url = new URL(path, 'http://console.invalid/')
    if (url.pathname === '/api/me') return json(fixtureMe)
    if (url.pathname === '/api/directory') return json(opts.dir ?? directory())
    if (url.pathname === '/api/activity') return json(fixtureActivity)
    if (url.pathname === '/api/inbox/summary') return opts.inbox ? opts.inbox() : json(summary())
    return json({ error: 'not_found' }, 404)
  })
  return { summaryCalls: () => paths.filter((p) => p === 'api/inbox/summary').length }
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const header = () => document.querySelector('header') as HTMLElement

describe('the rules', () => {
  it('a card shows the count only while the answering session is not online', () => {
    const dir = directory()
    expect(agentWaiting(dir.members[0]!, NOW)).toBeNull() // bob: online
    expect(agentWaiting(dir.members[1]!, NOW)).toBe(3) // carol: stopped
    expect(agentWaiting({ ...dir.members[1]!, inbox_waiting: 0 }, NOW)).toBeNull()
    const older = structuredClone(dir.members[1]!)
    delete older.inbox_waiting // an older relay
    expect(agentWaiting(older, NOW)).toBeNull()
  })

  it('the header line counts questions, singular and at the cap', () => {
    expect(waitingLine(summary(), NOW)).toBe('2 questions waiting for you')
    expect(waitingLine(summary({ pending: 1, from: ['bob'] }), NOW)).toBe('1 question waiting for you')
    expect(waitingLine(summary({ pending: 50, more: true }), NOW)).toBe('50+ questions waiting for you')
    expect(waitingLine(summary({ pending: 0, from: [] }), NOW)).toBeNull()
    expect(waitingLine(summary({ answering: { last_seen: '2026-09-23T10:14:50.000Z' } }), NOW)).toBeNull()
    expect(waitingLine(summary({ answering: { last_seen: '2026-09-23T10:14:00.000Z' } }), NOW)).toBe('2 questions waiting for you')
    expect(waitingLine(undefined, NOW)).toBeNull()
  })
})

describe('the console', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW)
    setHidden(false)
    setConsoleKey(KEY)
  })
  afterEach(() => {
    setHidden(false)
  })

  it('marks the card of a teammate whose answering session stopped with questions waiting, in amber', async () => {
    server()
    renderWithClient(<App />)
    await flush(10)
    const carol = document.querySelector('[data-agent="carol"]') as HTMLElement
    const badge = carol.querySelector('[data-waiting]') as HTMLElement
    expect(badge).toHaveAttribute('data-waiting', '3')
    expect(badge).toHaveTextContent('3 waiting')
    expect(badge.querySelector('.text-warn')).not.toBeNull()
    // bob's answering session is online: it takes them now, so nothing is shown.
    expect(document.querySelector('[data-agent="bob"] [data-waiting]')).toBeNull()
  })

  it('shows the viewer\'s own waiting questions in the header, and follows the summary', async () => {
    let current = summary()
    const s = server({ inbox: () => json(current) })
    renderWithClient(<App />)
    await flush(10)
    expect(header().querySelector('[data-inbox-waiting]')).toHaveTextContent('2 questions waiting for you')

    // The answering session starts and takes them: the line goes.
    current = summary({ pending: 0, from: [], oldest_at: null, answering: { last_seen: FIXTURE_NOW } })
    await flush(DIRECTORY_INTERVAL_MS + 10)
    expect(s.summaryCalls()).toBeGreaterThanOrEqual(2)
    expect(header().querySelector('[data-inbox-waiting]')).toBeNull()
    expect(header()).not.toHaveTextContent('waiting for you')
  })

  it('says nothing while the viewer\'s answering session is online', async () => {
    server({ inbox: () => json(summary({ answering: { last_seen: '2026-09-23T10:14:55.000Z' } })) })
    renderWithClient(<App />)
    await flush(10)
    expect(header().querySelector('[data-inbox-waiting]')).toBeNull()
  })

  it('a console server without the summary (404) shows nothing and is not asked again', async () => {
    const s = server({ inbox: () => json({ error: 'not_found' }, 404) })
    renderWithClient(<App />)
    await flush(10)
    expect(header().querySelector('[data-inbox-waiting]')).toBeNull()
    expect(header()).toHaveTextContent('Team demo')
    const calls = s.summaryCalls()
    await flush(3 * DIRECTORY_INTERVAL_MS)
    expect(s.summaryCalls()).toBe(calls)
  })

  it('the dev mock shows both with ?waiting', async () => {
    const relay = new MockRelay(() => Date.now())
    relay.waiting = true
    setTransport((path, init) => relay.handle(path, init))
    renderWithClient(<App />)
    await flush(500)
    expect(header().querySelector('[data-inbox-waiting]')).toHaveTextContent('2 questions waiting for you')
    expect(document.querySelector('[data-agent="carol"] [data-waiting]')).toHaveTextContent('3 waiting')
    expect(document.querySelector('[data-agent="bob"] [data-waiting]')).toBeNull()
  })
})
