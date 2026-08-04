import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  SESSION_MAX_AGE_SECONDS,
  decodeSessionCookie,
  encodeSessionCookie,
  sessionCookieOptions,
} from './session-cookie'
import type { Session } from './types'

const SECRET = 'a'.repeat(48)
const OTHER_SECRET = 'b'.repeat(48)

const session: Session = {
  handle: 'torvalds',
  githubId: 1024025,
  avatarUrl: 'https://avatars.githubusercontent.com/u/1024025',
}

describe('encodeSessionCookie / decodeSessionCookie', () => {
  it('round trips a session unchanged', () => {
    const cookie = encodeSessionCookie(session, SECRET)
    expect(decodeSessionCookie(cookie, SECRET)).toEqual(session)
  })

  it('round trips a null avatar', () => {
    const anon: Session = { ...session, avatarUrl: null }
    const cookie = encodeSessionCookie(anon, SECRET)
    expect(decodeSessionCookie(cookie, SECRET)?.avatarUrl).toBeNull()
  })

  /**
   * The one that matters. `api/sync` takes the handle from the session and
   * writes that user's row, so a payload editable by its bearer would let
   * anyone overwrite anyone else's data.
   */
  it('rejects a payload edited to claim a different handle', () => {
    const cookie = encodeSessionCookie(session, SECRET)
    const [, signature] = cookie.split('.')

    const forged = Buffer.from(
      JSON.stringify({ h: 'victim', i: 1, a: null, exp: Math.floor(Date.now() / 1000) + 999 }),
      'utf8'
    ).toString('base64url')

    expect(decodeSessionCookie(`${forged}.${signature}`, SECRET)).toBeNull()
  })

  it('rejects a cookie signed with a different secret', () => {
    const cookie = encodeSessionCookie(session, OTHER_SECRET)
    expect(decodeSessionCookie(cookie, SECRET)).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const [body] = encodeSessionCookie(session, SECRET).split('.')
    expect(decodeSessionCookie(`${body}.not-the-signature`, SECRET)).toBeNull()
  })

  it('rejects an expired cookie', () => {
    const issuedAt = 1_000_000
    const cookie = encodeSessionCookie(session, SECRET, issuedAt)

    // One second before expiry it is still good, one second after it is not.
    expect(decodeSessionCookie(cookie, SECRET, issuedAt + SESSION_MAX_AGE_SECONDS - 1)).toEqual(
      session
    )
    expect(
      decodeSessionCookie(cookie, SECRET, issuedAt + SESSION_MAX_AGE_SECONDS + 1)
    ).toBeNull()
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['too many parts', 'a.b.c'],
    ['empty body', '.signature'],
  ])('returns null for a malformed cookie (%s)', (_label, raw) => {
    expect(decodeSessionCookie(raw as string | undefined | null, SECRET)).toBeNull()
  })

  it('returns null when the signed payload is not valid JSON', () => {
    // Signed by us, so it passes the signature check and must then be
    // rejected by parsing rather than crashing.
    const body = Buffer.from('not json at all', 'utf8').toString('base64url')
    const signature = createHmac('sha256', SECRET).update(body).digest('base64url')
    expect(decodeSessionCookie(`${body}.${signature}`, SECRET)).toBeNull()
  })

  it.each([
    ['missing handle', { i: 1, a: null, exp: 9_999_999_999 }],
    ['numeric handle', { h: 42, i: 1, a: null, exp: 9_999_999_999 }],
    ['empty handle', { h: '', i: 1, a: null, exp: 9_999_999_999 }],
    ['string id', { h: 'x', i: '1', a: null, exp: 9_999_999_999 }],
    ['object avatar', { h: 'x', i: 1, a: {}, exp: 9_999_999_999 }],
    ['missing exp', { h: 'x', i: 1, a: null }],
  ])('returns null for a correctly signed but wrong-shaped payload (%s)', (_label, payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signature = createHmac('sha256', SECRET).update(body).digest('base64url')
    expect(decodeSessionCookie(`${body}.${signature}`, SECRET)).toBeNull()
  })
})

describe('getSessionSecret', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when unset', async () => {
    vi.stubEnv('SESSION_SECRET', '')
    const { getSessionSecret } = await import('./session-cookie')
    expect(getSessionSecret()).toBeNull()
  })

  /**
   * A short key is the dangerous case precisely because everything still
   * works with one. Refusing it is the only way the problem is ever noticed.
   */
  it('refuses a secret shorter than 32 characters', async () => {
    vi.stubEnv('SESSION_SECRET', 'too-short')
    const { getSessionSecret } = await import('./session-cookie')
    expect(getSessionSecret()).toBeNull()
  })

  it('accepts and trims a long enough secret', async () => {
    vi.stubEnv('SESSION_SECRET', `  ${'x'.repeat(40)}  `)
    const { getSessionSecret } = await import('./session-cookie')
    expect(getSessionSecret()).toBe('x'.repeat(40))
  })
})

describe('sessionCookieOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is httpOnly and lax so the GitHub redirect still carries it', () => {
    const options = sessionCookieOptions()
    expect(options.httpOnly).toBe(true)
    // 'strict' would withhold the cookie on the top-level navigation back
    // from github.com, which breaks the callback.
    expect(options.sameSite).toBe('lax')
    expect(options.path).toBe('/')
  })

  it('is secure in production and not in development', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.resetModules()
    const prod = await import('./session-cookie')
    expect(prod.sessionCookieOptions().secure).toBe(true)

    vi.stubEnv('NODE_ENV', 'development')
    vi.resetModules()
    const dev = await import('./session-cookie')
    expect(dev.sessionCookieOptions().secure).toBe(false)
  })

  it('passes through a zero maxAge, which is how sign out clears the cookie', () => {
    expect(sessionCookieOptions(0).maxAge).toBe(0)
  })
})
