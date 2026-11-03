/**
 * The in-process cache and rate limiter. Neither is a distributed guarantee (that is
 * documented in the module), but both have to behave correctly for one warm instance, and the
 * window table has to stay bounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheClearAll, cacheGetFresh, cacheGetStale, cacheSet, checkRateLimit, rateLimitEntryCount } from './api-cache'

beforeEach(() => {
  cacheClearAll()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the response cache', () => {
  it('serves a fresh entry and keeps it available as stale afterwards', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    cacheSet('k', { value: 1 }, 1000)

    expect(cacheGetFresh('k')).toEqual({ value: 1 })

    vi.setSystemTime(new Date('2026-10-01T00:00:02.000Z'))
    expect(cacheGetFresh('k')).toBeUndefined()
    // The stale path exists so a GitHub outage can serve something rather than nothing.
    expect(cacheGetStale('k')).toEqual({ value: 1 })
  })

  it('returns undefined for a key it has never seen', () => {
    expect(cacheGetFresh('nope')).toBeUndefined()
    expect(cacheGetStale('nope')).toBeUndefined()
  })
})

describe('the rate limiter', () => {
  it('allows exactly `limit` requests inside one window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))

    expect(checkRateLimit('ip:a', 2, 1000).allowed).toBe(true)
    expect(checkRateLimit('ip:a', 2, 1000).allowed).toBe(true)

    const third = checkRateLimit('ip:a', 2, 1000)
    expect(third.allowed).toBe(false)
    expect(third.remaining).toBe(0)
  })

  it('gives a fresh allowance once the window has elapsed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    expect(checkRateLimit('ip:a', 1, 1000).allowed).toBe(true)
    expect(checkRateLimit('ip:a', 1, 1000).allowed).toBe(false)

    vi.setSystemTime(new Date('2026-10-01T00:00:02.000Z'))
    expect(checkRateLimit('ip:a', 1, 1000).allowed).toBe(true)
  })

  it('does not keep windows it can never use again', () => {
    // The table is fed by inbound traffic, so leaving it unbounded made process memory a
    // function of how many distinct keys had ever been seen.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    for (let i = 0; i < 50; i += 1) {
      checkRateLimit(`ip:${i}`, 30, 1000)
    }
    expect(rateLimitEntryCount()).toBe(50)

    // Past both the window and the sweep interval, so the next call prunes.
    vi.setSystemTime(new Date('2026-10-01T00:02:00.000Z'))
    checkRateLimit('ip:fresh', 30, 1000)

    expect(rateLimitEntryCount()).toBe(1)
  })

  it('keeps counting a window that is still open while pruning older ones', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    checkRateLimit('ip:long', 5, 10 * 60_000)
    checkRateLimit('ip:short', 5, 1000)

    vi.setSystemTime(new Date('2026-10-01T00:02:00.000Z'))
    checkRateLimit('ip:trigger', 5, 1000)

    // The ten-minute window is still live and must still count.
    expect(checkRateLimit('ip:long', 5, 10 * 60_000).allowed).toBe(true)
    expect(checkRateLimit('ip:long', 5, 10 * 60_000).allowed).toBe(true)
    expect(checkRateLimit('ip:long', 5, 10 * 60_000).allowed).toBe(true)
    expect(checkRateLimit('ip:long', 5, 10 * 60_000).allowed).toBe(true)
    const sixth = checkRateLimit('ip:long', 5, 10 * 60_000)
    expect(sixth.allowed).toBe(false)
  })
})
