import { describe, expect, it } from 'vitest'

import { IDLE_MS, ONLINE_MS, presenceOf } from './presence'

const NOW = Date.parse('2026-09-23T10:15:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('presenceOf', () => {
  it('is online under 45 s', () => {
    expect(presenceOf(ago(0), NOW)).toBe('online')
    expect(presenceOf(ago(44_999), NOW)).toBe('online')
  })

  it('is idle from 45 s to under 5 minutes', () => {
    expect(ONLINE_MS).toBe(45_000)
    expect(presenceOf(ago(45_000), NOW)).toBe('idle')
    expect(presenceOf(ago(299_999), NOW)).toBe('idle')
  })

  it('is offline from 5 minutes, and when never seen', () => {
    expect(IDLE_MS).toBe(300_000)
    expect(presenceOf(ago(300_000), NOW)).toBe('offline')
    expect(presenceOf(ago(86_400_000), NOW)).toBe('offline')
    expect(presenceOf(null, NOW)).toBe('offline')
    expect(presenceOf('not a time', NOW)).toBe('offline')
  })

  it('treats a timestamp slightly ahead of the local clock as online', () => {
    expect(presenceOf(ago(-2_000), NOW)).toBe('online')
  })
})
