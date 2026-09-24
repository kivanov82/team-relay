import { describe, expect, it } from 'vitest'

import { ApiError, getJson, setTransport } from './client'
import { setConsoleKey } from './key'

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  setConsoleKey('k'.repeat(32))
  setTransport(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }))
}

async function failure(): Promise<ApiError> {
  const err = await getJson('api/activity').catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ApiError)
  return err as ApiError
}

describe('getJson errors', () => {
  it('reads 429 as rate limited, with Retry-After when given', async () => {
    respond(429, { error: 'rate_limited' }, { 'Retry-After': '20' })
    const err = await failure()
    expect(err.kind).toBe('rate_limited')
    expect(err.retryAfterMs).toBe(20_000)

    respond(429, { error: 'rate_limited' })
    expect((await failure()).retryAfterMs).toBeNull()

    respond(429, {}, { 'Retry-After': 'Wed, 23 Sep 2026 10:00:00 GMT' })
    expect((await failure()).retryAfterMs).toBeNull()

    respond(429, {}, { 'Retry-After': '99999' })
    expect((await failure()).retryAfterMs).toBe(300_000)
  })

  it('reads the console server’s relay refusal with status 429 as rate limited', async () => {
    respond(502, { error: 'relay_refused', relay_status: 429, relay_error: 'rate_limited' })
    expect((await failure()).kind).toBe('rate_limited')
  })

  it('reads any other 502 as the relay being unreachable', async () => {
    respond(502, { error: 'relay_refused', relay_status: 500, relay_error: 'internal' })
    expect((await failure()).kind).toBe('relay_unreachable')
    respond(502, { error: 'relay_unreachable', detail: 'ECONNREFUSED' })
    expect((await failure()).kind).toBe('relay_unreachable')
    setTransport(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    expect((await failure()).kind).toBe('relay_unreachable')
  })
})

describe('getJson locally (M2 §4.4, unchanged by M3)', () => {
  it('sends the key, no cookie, and never follows a redirect', async () => {
    const seen: RequestInit[] = []
    setConsoleKey('k'.repeat(32))
    setTransport(async (_path, init) => {
      seen.push(init)
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await getJson('api/me')
    expect(new Headers(seen[0]!.headers).get('X-Console-Key')).toBe('k'.repeat(32))
    expect(seen[0]!.credentials).toBe('omit')
    expect(seen[0]!.redirect).toBe('manual')
  })

  it('without a key calls nothing and is unauthorized', async () => {
    setConsoleKey(null)
    let called = false
    setTransport(async () => {
      called = true
      return new Response('{}')
    })
    expect((await failure()).kind).toBe('unauthorized')
    expect(called).toBe(false)
  })

  it('reads the console server’s JSON 401/403 as a refused key, and anything else as an expired session', async () => {
    respond(401, { error: 'unauthenticated' })
    expect((await failure()).kind).toBe('unauthorized')
    respond(403, { error: 'forbidden' })
    expect((await failure()).kind).toBe('unauthorized')
    setTransport(async () => new Response('<html>sign in</html>', { status: 401, headers: { 'Content-Type': 'text/html' } }))
    expect((await failure()).kind).toBe('session_expired')
    setTransport(async () => new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/' } }))
    expect((await failure()).kind).toBe('session_expired')
  })
})
