import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubIdentity,
  resolveRedirectUri,
  type OAuthConfig,
} from './github-oauth'

const config: OAuthConfig = { clientId: 'Iv23liExample', clientSecret: 'secret-value' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('getOAuthConfig', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when neither variable is set', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', '')
    vi.stubEnv('GITHUB_CLIENT_SECRET', '')
    const { getOAuthConfig } = await import('./github-oauth')
    expect(getOAuthConfig()).toBeNull()
  })

  /** Half-configured is the state a partial copy-paste leaves behind. */
  it('returns null when only the id is set', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'Iv23liExample')
    vi.stubEnv('GITHUB_CLIENT_SECRET', '')
    const { getOAuthConfig } = await import('./github-oauth')
    expect(getOAuthConfig()).toBeNull()
  })

  it('returns null when only the secret is set', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', '')
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'secret-value')
    const { getOAuthConfig } = await import('./github-oauth')
    expect(getOAuthConfig()).toBeNull()
  })

  it('returns both, trimmed, when set', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', '  Iv23liExample  ')
    vi.stubEnv('GITHUB_CLIENT_SECRET', ' secret-value ')
    const { getOAuthConfig } = await import('./github-oauth')
    expect(getOAuthConfig()).toEqual(config)
  })
})

describe('buildAuthorizeUrl', () => {
  it('points at GitHub and carries id, state, and redirect', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'Iv23liExample',
        state: 'random-state',
        redirectUri: 'http://localhost:3000/api/auth/callback',
      })
    )
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('Iv23liExample')
    expect(url.searchParams.get('state')).toBe('random-state')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback')
  })

  /**
   * The app asks for no repository, organization, or account permissions.
   * A scope appearing here would be a widening of access that nothing in the
   * product currently needs, so it should fail a test rather than pass review.
   */
  it('requests no scopes at all', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'Iv23liExample',
        state: 's',
        redirectUri: 'http://localhost:3000/api/auth/callback',
      })
    )
    expect(url.searchParams.has('scope')).toBe(false)
  })
})

describe('resolveRedirectUri', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('derives the callback from the request origin', () => {
    expect(resolveRedirectUri('http://localhost:3000')).toBe(
      'http://localhost:3000/api/auth/callback'
    )
  })

  it('strips a trailing slash rather than producing a double slash', () => {
    expect(resolveRedirectUri('https://example.com/')).toBe(
      'https://example.com/api/auth/callback'
    )
  })

  it('prefers AUTH_BASE_URL when set, for proxies that rewrite the origin', () => {
    vi.stubEnv('AUTH_BASE_URL', 'https://garden.example.com')
    expect(resolveRedirectUri('http://internal:3000')).toBe(
      'https://garden.example.com/api/auth/callback'
    )
  })
})

describe('exchangeCodeForToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the access token on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ access_token: 'ghu_token', token_type: 'bearer' }))
    )
    await expect(exchangeCodeForToken('code', config, 'http://localhost:3000/cb')).resolves.toBe(
      'ghu_token'
    )
  })

  it('posts the code, both credentials, and the redirect uri', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: 't' }))
    vi.stubGlobal('fetch', fetchMock)

    await exchangeCodeForToken('the-code', config, 'http://localhost:3000/cb')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://github.com/login/oauth/access_token')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: 'the-code',
      redirect_uri: 'http://localhost:3000/cb',
    })
  })

  /**
   * The trap this endpoint sets: GitHub reports a rejected code with HTTP
   * 200 and an `error` field. Trusting the status alone would carry an
   * undefined token forward and sign in a user who never authenticated.
   */
  it('returns null when GitHub reports an error inside a 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: 'bad_verification_code', error_description: 'expired' })
      )
    )
    await expect(
      exchangeCodeForToken('stale', config, 'http://localhost:3000/cb')
    ).resolves.toBeNull()
  })

  it('returns null on a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 500)))
    await expect(exchangeCodeForToken('c', config, 'http://x/cb')).resolves.toBeNull()
  })

  it('returns null rather than throwing when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(exchangeCodeForToken('c', config, 'http://x/cb')).resolves.toBeNull()
  })

  it('returns null when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>nope</html>')))
    await expect(exchangeCodeForToken('c', config, 'http://x/cb')).resolves.toBeNull()
  })

  it('returns null when access_token is an empty string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ access_token: '' })))
    await expect(exchangeCodeForToken('c', config, 'http://x/cb')).resolves.toBeNull()
  })
})

describe('fetchGithubIdentity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps the GitHub user payload onto a session identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ login: 'Torvalds', id: 1024025, avatar_url: 'https://a/x.png' })
      )
    )
    await expect(fetchGithubIdentity('token')).resolves.toEqual({
      handle: 'torvalds',
      githubId: 1024025,
      avatarUrl: 'https://a/x.png',
    })
  })

  /**
   * GitHub logins are case-insensitive and the handle is the primary key in
   * `SyncStore`, so lowercasing at this boundary is what stops `Torvalds`
   * and `torvalds` becoming two rows.
   */
  it('lowercases the handle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ login: 'MixedCase', id: 7, avatar_url: null }))
    )
    const identity = await fetchGithubIdentity('token')
    expect(identity?.handle).toBe('mixedcase')
  })

  it('sends the token as a bearer credential', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ login: 'x', id: 1, avatar_url: null }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGithubIdentity('ghu_abc')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/user')
    expect(init.headers.Authorization).toBe('Bearer ghu_abc')
  })

  it('normalises a missing avatar to null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ login: 'x', id: 1, avatar_url: '' }))
    )
    const identity = await fetchGithubIdentity('token')
    expect(identity?.avatarUrl).toBeNull()
  })

  it('returns null on a 401, which is what a revoked token gives', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'Bad creds' }, 401)))
    await expect(fetchGithubIdentity('token')).resolves.toBeNull()
  })

  it.each([
    ['missing login', { id: 1, avatar_url: null }],
    ['missing id', { login: 'x', avatar_url: null }],
    ['string id', { login: 'x', id: '1', avatar_url: null }],
  ])('returns null for a malformed user payload (%s)', async (_label, payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)))
    await expect(fetchGithubIdentity('token')).resolves.toBeNull()
  })

  it('returns null rather than throwing when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(fetchGithubIdentity('token')).resolves.toBeNull()
  })
})
