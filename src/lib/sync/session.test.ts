import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

/**
 * Every test re-imports the module fresh via `vi.resetModules()` +
 * dynamic `import()` so mutations to `NODE_ENV` / `STUB_SESSION_HANDLE` in
 * one test can never leak into another (mirrors the pattern in
 * `src/app/api/creature/route.test.ts`). `vi.stubEnv` is used instead of
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

  it('getSessionProvider() refuses to run in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const { getSessionProvider } = await import('./session')
    expect(() => getSessionProvider()).toThrow(/production/i)
  })

  it('getSessionProvider() returns a working stub outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('STUB_SESSION_HANDLE', 'someone')
    const { getSessionProvider } = await import('./session')
    const provider = getSessionProvider()
    expect(provider.id).toBe('stub')
    const session = await provider.current()
    expect(session?.handle).toBe('someone')
  })
})
