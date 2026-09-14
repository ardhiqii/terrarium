import { afterEach, describe, expect, it, vi } from 'vitest'
import { GithubAccountSqliteStore } from './github-account-store'
import type { GithubIdentity } from './github-oauth'

const identity: GithubIdentity = {
  handle: 'Octo',
  githubId: 42,
  avatarUrl: null,
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GithubAccountSqliteStore', () => {
  it('encrypts and round-trips a server-side credential without exposing it in settings', async () => {
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(32))
    const store = new GithubAccountSqliteStore(':memory:')

    await store.putCredential(identity, 'ghu_secret_token', ['repo', 'read:org'])
    expect(await store.getToken(42)).toBe('ghu_secret_token')
    expect(await store.getSettings(42)).toEqual({
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    })
    expect(await store.get(42)).toMatchObject({ githubId: 42, handle: 'octo', scopes: ['repo', 'read:org'] })
  })

  it('preserves source choices when OAuth reconnects and refreshes the token', async () => {
    vi.stubEnv('SESSION_SECRET', 'b'.repeat(32))
    const store = new GithubAccountSqliteStore(':memory:')
    await store.putCredential(identity, 'first-token', ['repo'])
    await store.saveSettings(42, {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: true,
      autoIncludeOrganizations: ['Acme'],
      baselineByRepositoryId: { '101': '2026-09-12T00:00:00.000Z' },
      lastSyncedAt: '2026-09-12T01:00:00.000Z',
    })

    await store.putCredential(identity, 'second-token', ['repo', 'read:org'])
    expect(await store.getToken(42)).toBe('second-token')
    expect(await store.getSettings(42)).toEqual({
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: true,
      autoIncludeOrganizations: ['acme'],
      baselineByRepositoryId: { '101': '2026-09-12T00:00:00.000Z' },
      lastSyncedAt: '2026-09-12T01:00:00.000Z',
    })
  })

  it('fails closed when the encryption secret changes', async () => {
    vi.stubEnv('SESSION_SECRET', 'c'.repeat(32))
    const store = new GithubAccountSqliteStore(':memory:')
    await store.putCredential(identity, 'token', ['repo'])
    vi.stubEnv('SESSION_SECRET', 'd'.repeat(32))
    expect(await store.getToken(42)).toBeNull()
  })
})
