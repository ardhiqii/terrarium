import { describe, expect, it } from 'vitest'
import { DEFAULT_RETURN_PATH, loginHrefFor, safeReturnPath } from './oauth-return-path'

describe('safeReturnPath', () => {
  it('keeps a same-origin path so authorization returns to the right page', () => {
    // The bug: the callback always landed on `/`, so authorizing from /github
    // dropped the user on the home page with no way back.
    expect(safeReturnPath('/github')).toBe('/github')
    expect(safeReturnPath('/companions')).toBe('/companions')
    expect(safeReturnPath('/')).toBe('/')
  })

  it('preserves a query string on the return path', () => {
    expect(safeReturnPath('/notes/welcome-to-terrarium?from=search')).toBe(
      '/notes/welcome-to-terrarium?from=search',
    )
  })

  it('rejects protocol-relative URLs, which browsers treat as absolute', () => {
    // `//evil.example` is the classic open-redirect payload: it looks like a
    // path but navigates off-site.
    expect(safeReturnPath('//evil.example')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('//evil.example/github')).toBe(DEFAULT_RETURN_PATH)
  })

  it('rejects the backslash variant that normalises to a protocol-relative URL', () => {
    // `/\evil.example` is normalised to `//evil.example` by browsers.
    expect(safeReturnPath('/\\evil.example')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('/path\\to')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('\\\\evil.example')).toBe(DEFAULT_RETURN_PATH)
  })

  it('rejects absolute URLs of any scheme', () => {
    expect(safeReturnPath('https://evil.example')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('http://evil.example/github')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('javascript:alert(1)')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('data:text/html,<script>alert(1)</script>')).toBe(DEFAULT_RETURN_PATH)
  })

  it('rejects control characters that could split a response header', () => {
    expect(safeReturnPath('/github\r\nLocation: https://evil.example')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('/github\nSet-Cookie: x=1')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('/github\u0000')).toBe(DEFAULT_RETURN_PATH)
  })

  it('falls back for empty, missing, or non-string input', () => {
    expect(safeReturnPath(undefined)).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath(null)).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('   ')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath(42)).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath({ toString: () => '/github' })).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('/github')).not.toBe(DEFAULT_RETURN_PATH)
  })

  it('rejects a path with no leading slash, including bare words', () => {
    expect(safeReturnPath('github')).toBe(DEFAULT_RETURN_PATH)
    expect(safeReturnPath('evil.example/github')).toBe(DEFAULT_RETURN_PATH)
  })

  it('rejects an over-long value that would bloat the cookie', () => {
    expect(safeReturnPath(`/${'a'.repeat(600)}`)).toBe(DEFAULT_RETURN_PATH)
    // Just inside the bound still works, so the limit is not off by one.
    expect(safeReturnPath(`/${'a'.repeat(500)}`)).toBe(`/${'a'.repeat(500)}`)
  })

  it('trims surrounding whitespace rather than rejecting it', () => {
    expect(safeReturnPath('  /github  ')).toBe('/github')
  })
})

describe('loginHrefFor', () => {
  it('carries the current page so the flow returns there', () => {
    expect(loginHrefFor('/github')).toBe('/api/auth/login?next=%2Fgithub')
  })

  it('omits the parameter entirely for an unusable path', () => {
    // A rejected value must never widen the link.
    expect(loginHrefFor('//evil.example')).toBe('/api/auth/login')
    expect(loginHrefFor(undefined)).toBe('/api/auth/login')
    expect(loginHrefFor('/')).toBe('/api/auth/login')
  })

  it('encodes a path so the query cannot be broken out of', () => {
    const href = loginHrefFor('/search?q=a&b=c')
    expect(href.startsWith('/api/auth/login?next=')).toBe(true)
    expect(href).not.toContain('&b=c')
    expect(new URL(href, 'https://example.test').searchParams.get('next')).toBe('/search?q=a&b=c')
  })
})
