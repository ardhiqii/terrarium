/**
 * The shared creature-route helpers. This module had no tests at all, and it holds the one
 * function that decides WHOSE rate-limit bucket a request is charged to.
 */
import { describe, expect, it } from 'vitest'
import { getClientIp } from './creature-route-shared'

function request(headers: Record<string, string>) {
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { headers: { get: (name: string) => lowered[name.toLowerCase()] ?? null } }
}

describe('getClientIp', () => {
  it('prefers CF-Connecting-IP, the one header a client cannot choose', () => {
    // Cloudflare's edge overwrites this value. X-Forwarded-For is whatever the caller sent,
    // plus whatever the proxy appended.
    const ip = getClientIp(request({
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '1.2.3.4',
    }))
    expect(ip).toBe('203.0.113.7')
  })

  it('uses the LAST X-Forwarded-For hop, not the caller-supplied first one', () => {
    // This was the defect: `split(',')[0]` returned the attacker's string, so rotating the
    // header per request meant never meeting the limit — and pinning a chosen value meant
    // exhausting someone else's bucket instead.
    const ip = getClientIp(request({ 'x-forwarded-for': 'spoofed-by-client, 198.51.100.9' }))
    expect(ip).toBe('198.51.100.9')
  })

  it('takes the single hop a plain proxy produces', () => {
    expect(getClientIp(request({ 'x-forwarded-for': '198.51.100.9' }))).toBe('198.51.100.9')
  })

  it('falls back to x-real-ip when there is no forwarded chain', () => {
    expect(getClientIp(request({ 'x-real-ip': '192.0.2.44' }))).toBe('192.0.2.44')
  })

  it('returns one shared bucket, never a random key, when no proxy header is present', () => {
    // Fail-closed: every caller shares a single limit rather than each getting a fresh one.
    expect(getClientIp(request({}))).toBe('unknown')
    expect(getClientIp(request({ 'x-forwarded-for': '   ' }))).toBe('unknown')
  })

  it('ignores empty hops and trims whitespace', () => {
    expect(getClientIp(request({ 'x-forwarded-for': ' , 198.51.100.9 , ' }))).toBe('198.51.100.9')
    expect(getClientIp(request({ 'cf-connecting-ip': '  203.0.113.7  ' }))).toBe('203.0.113.7')
  })
})
