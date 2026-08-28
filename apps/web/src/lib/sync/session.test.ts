import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

/**
 * Every test re-imports the module fresh via `vi.resetModules()` +
 * dynamic `import()` so mutations to `NODE_ENV` / `STUB_SESSION_HANDLE` in
 * one test can never leak into another (mirrors the pattern in
 * `apps/web/src/app/api/creature/route.test.ts`). `vi.stubEnv` is used instead of
 * assigning `process.env.NODE_ENV` directly because `@types/node` (via the
 * Next.js plugin) types that property read-only; `vi.unstubAllEnvs()`
 * restores everything after each test.
 */
describe('StubSessionProvider and getSessionProvider', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null (signed out) when STUB_SESSION_HANDLE is unset', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('STUB_SESSION_HANDLE', '')
    const { StubSessionProvider } = await import('./session')
    const provider = new StubSessionProvider()
    await expect(provider.current()).resolves.toBeNull()
  })

  it('returns a session with the lowercased handle when set', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('STUB_SESSION_HANDLE', 'Torvalds')
    const { StubSessionProvider } = await import('./session')
    const provider = new StubSessionProvider()
    const session = await provider.current()
    expect(session).not.toBeNull()
    expect(session?.handle).toBe('torvalds')
    expect(typeof session?.githubId).toBe('number')
    expect(session?.avatarUrl).toBeNull()
  })

  it('is stable: the same handle always yields the same fake githubId', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('STUB_SESSION_HANDLE', 'octocat')
    const { StubSessionProvider } = await import('./session')
    const provider = new StubSessionProvider()
    const first = await provider.current()
    const second = await provider.current()
    expect(first?.githubId).toBe(second?.githubId)
  })

  it('the constructor throws when NODE_ENV is production, even bypassing the selector', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { StubSessionProvider } = await import('./session')
    expect(() => new StubSessionProvider()).toThrow(/production/i)
  })

  it('getSessionProvider() never hands back the stub in production', async () => {
    // Signed-out, not thrown. Refusing the stub is correct (it reads the
    // handle from an env var, so shipping it would let anyone sign in as
    // anyone), but throwing broke `npm run build` outright, because
    // `layout.tsx` reads the session at the root during prerendering.
    // Fail closed, not broken: no session, but every public page renders.
    vi.stubEnv('NODE_ENV', 'production')
    // Stated explicitly rather than relying on these being absent from the
    // ambient environment: with OAuth configured the selector would return
    // the real provider, and this test is about the unconfigured case.
    vi.stubEnv('GITHUB_CLIENT_ID', '')
    vi.stubEnv('GITHUB_CLIENT_SECRET', '')
    vi.stubEnv('SESSION_SECRET', '')
    const { getSessionProvider } = await import('./session')
    const provider = getSessionProvider()
    expect(provider.id).not.toBe('stub')
    await expect(provider.current()).resolves.toBeNull()
  })

  it('getSessionProvider() returns a working stub outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('STUB_SESSION_HANDLE', 'someone')
    vi.stubEnv('GITHUB_CLIENT_ID', '')
    vi.stubEnv('GITHUB_CLIENT_SECRET', '')
    vi.stubEnv('SESSION_SECRET', '')
    const { getSessionProvider } = await import('./session')
    const provider = getSessionProvider()
    expect(provider.id).toBe('stub')
    const session = await provider.current()
    expect(session?.handle).toBe('someone')
  })
})

const LONG_SECRET = 'k'.repeat(48)

describe('isOAuthConfigured and provider selection', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function loadWith(env: Record<string, string>) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    return import('./session')
  }

  it('is false when nothing is set', async () => {
    const { isOAuthConfigured } = await loadWith({
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
      SESSION_SECRET: '',
    })
    expect(isOAuthConfigured()).toBe(false)
  })

  /**
   * Credentials without a signing key is the genuinely dangerous
   * half-configuration: the flow would authenticate the user correctly and
   * then have no way to issue a cookie, looping them back to signed out.
   * Better to report not-configured and never start.
   */
  it('is false with credentials but no session secret', async () => {
    const { isOAuthConfigured } = await loadWith({
      GITHUB_CLIENT_ID: 'Iv23liExample',
      GITHUB_CLIENT_SECRET: 'secret',
      SESSION_SECRET: '',
    })
    expect(isOAuthConfigured()).toBe(false)
  })

  it('is false with a session secret but no credentials', async () => {
    const { isOAuthConfigured } = await loadWith({
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
      SESSION_SECRET: LONG_SECRET,
    })
    expect(isOAuthConfigured()).toBe(false)
  })

  it('is false when the session secret is too short to sign with', async () => {
    const { isOAuthConfigured } = await loadWith({
      GITHUB_CLIENT_ID: 'Iv23liExample',
      GITHUB_CLIENT_SECRET: 'secret',
      SESSION_SECRET: 'short',
    })
    expect(isOAuthConfigured()).toBe(false)
  })

  it('is true when fully configured', async () => {
    const { isOAuthConfigured } = await loadWith({
      GITHUB_CLIENT_ID: 'Iv23liExample',
      GITHUB_CLIENT_SECRET: 'secret',
      SESSION_SECRET: LONG_SECRET,
    })
    expect(isOAuthConfigured()).toBe(true)
  })

  it('selects the real GitHub provider in production once configured', async () => {
    const { getSessionProvider, GithubSessionProvider } = await loadWith({
      NODE_ENV: 'production',
      GITHUB_CLIENT_ID: 'Iv23liExample',
      GITHUB_CLIENT_SECRET: 'secret',
      SESSION_SECRET: LONG_SECRET,
    })
    const provider = getSessionProvider()
    expect(provider).toBeInstanceOf(GithubSessionProvider)
    expect(provider.id).toBe('github')
  })

  /**
   * Configured wins in development too, so the real flow gets exercised
   * against a localhost callback rather than being tried for the first time
   * in production.
   */
  it('prefers the real provider over the stub in development once configured', async () => {
    const { getSessionProvider, GithubSessionProvider } = await loadWith({
      NODE_ENV: 'development',
      STUB_SESSION_HANDLE: 'someone',
      GITHUB_CLIENT_ID: 'Iv23liExample',
      GITHUB_CLIENT_SECRET: 'secret',
      SESSION_SECRET: LONG_SECRET,
    })
    expect(getSessionProvider()).toBeInstanceOf(GithubSessionProvider)
  })

  /**
   * `current()` must answer rather than reject when there is no request
   * scope to read a cookie from. Calling it outside a request, as happens
   * during prerendering, is exactly that case.
   */
  it('GithubSessionProvider resolves to null outside a request context', async () => {
    const { GithubSessionProvider } = await loadWith({
      NODE_ENV: 'test',
      GITHUB_CLIENT_ID: 'Iv23liExample',
      GITHUB_CLIENT_SECRET: 'secret',
      SESSION_SECRET: LONG_SECRET,
    })
    await expect(new GithubSessionProvider().current()).resolves.toBeNull()
  })

  it('GithubSessionProvider resolves to null when the signing key is missing', async () => {
    const { GithubSessionProvider } = await loadWith({
      NODE_ENV: 'test',
      SESSION_SECRET: '',
    })
    await expect(new GithubSessionProvider().current()).resolves.toBeNull()
  })
})
