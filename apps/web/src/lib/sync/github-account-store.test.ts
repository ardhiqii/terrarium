import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GithubAccountSqliteStore } from './github-account-store'
import { encryptGithubToken } from './github-token-crypto'
import type { GithubIdentity } from './github-oauth'

const identity: GithubIdentity = {
  handle: 'Octo',
  githubId: 42,
  avatarUrl: null,
}

const temporaryDirectories: string[] = []

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'terrarium-github-account-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'sync.db')
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Windows cannot delete a database file while the store still holds it
      // open, and the store has no close(). Cleanup is best effort; the OS
      // clears the temp directory.
    }
  }
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

  it('advances a baseline with compare-and-swap semantics', async () => {
    vi.stubEnv('SESSION_SECRET', 'e'.repeat(32))
    const store = new GithubAccountSqliteStore(':memory:')
    await store.putCredential(identity, 'token', ['repo'])
    const previous = { '101': '2026-09-12T00:00:00.000Z' }
    const next = { '101': '2026-09-14T00:00:00.000Z' }
    await store.saveSettings(42, {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: previous,
      lastSyncedAt: null,
    })

    await expect(store.advanceBaseline(42, previous, next, '2026-09-14T01:00:00.000Z')).resolves.toBe(true)
    await expect(store.advanceBaseline(42, previous, { '101': '2026-09-15T00:00:00.000Z' }, null)).resolves.toBe(false)
    await expect(store.getSettings(42)).resolves.toMatchObject({
      baselineByRepositoryId: next,
      lastSyncedAt: '2026-09-14T01:00:00.000Z',
    })
  })

  it('records the last successful checkpoint when the baseline map is unchanged and never moves it backwards', async () => {
    vi.stubEnv('SESSION_SECRET', 'e2'.repeat(16))
    const store = new GithubAccountSqliteStore(':memory:')
    await store.putCredential(identity, 'token', ['repo'])
    const baseline = { '101': '2026-09-12T00:00:00.000Z' }
    await store.saveSettings(42, {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: baseline,
      lastSyncedAt: null,
    })

    await expect(store.advanceBaseline(42, baseline, baseline, '2026-09-14T01:00:00.000Z')).resolves.toBe(true)
    await expect(store.advanceBaseline(42, baseline, baseline, '2026-09-13T01:00:00.000Z')).resolves.toBe(true)
    await expect(store.getSettings(42)).resolves.toMatchObject({
      baselineByRepositoryId: baseline,
      lastSyncedAt: '2026-09-14T01:00:00.000Z',
    })
  })

  it('disconnects by dropping the credential and baselines, keeping the user choices', async () => {
    vi.stubEnv('SESSION_SECRET', 'f'.repeat(32))
    const store = new GithubAccountSqliteStore(':memory:')
    await store.putCredential(identity, 'token', ['repo'])
    await store.saveSettings(42, {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: ['102'],
      autoIncludePersonal: true,
      autoIncludeOrganizations: ['Acme'],
      baselineByRepositoryId: { '101': '2026-09-12T00:00:00.000Z' },
      lastSyncedAt: '2026-09-12T01:00:00.000Z',
    })

    await store.clearCredential(42)

    expect(await store.getToken(42)).toBeNull()
    expect(await store.get(42)).toMatchObject({
      githubId: 42,
      handle: 'octo',
      // Selections are the user's, not the token's: they survive so
      // reconnecting resumes the same repositories.
      settings: {
        trackedRepositoryIds: ['101'],
        excludedRepositoryIds: ['102'],
        autoIncludePersonal: true,
        autoIncludeOrganizations: ['acme'],
        // Baselines are dropped: a disconnected window must never be
        // backfilled as new work on reconnect.
        baselineByRepositoryId: {},
        lastSyncedAt: null,
      },
    })

    // OAuth reconnects the same row and starts a fresh checkpoint.
    await store.putCredential(identity, 'second-token', ['repo'])
    expect(await store.getToken(42)).toBe('second-token')
    expect(await store.getSettings(42)).toEqual({
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: ['102'],
      autoIncludePersonal: true,
      autoIncludeOrganizations: ['acme'],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    })
  })

  it('keeps clearCredential from affecting any other account', async () => {
    vi.stubEnv('SESSION_SECRET', 'g'.repeat(32))
    const store = new GithubAccountSqliteStore(':memory:')
    await store.putCredential(identity, 'token', ['repo'])
    await store.putCredential({ handle: 'Other', githubId: 43, avatarUrl: null }, 'other-token', ['repo'])

    await store.clearCredential(42)

    expect(await store.getToken(42)).toBeNull()
    expect(await store.getToken(43)).toBe('other-token')
    // A different account starts with its own empty choices; it must never
    // inherit the disconnected account's selections.
    expect(await store.getSettings(43)).toEqual({
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    })
  })

  it('leaves remove() as the destructive control', async () => {
    vi.stubEnv('SESSION_SECRET', 'h'.repeat(32))
    const store = new GithubAccountSqliteStore(':memory:')
    await store.putCredential(identity, 'token', ['repo'])

    await store.remove(42)

    expect(await store.get(42)).toBeNull()
    expect(await store.getToken(42)).toBeNull()
  })

  it('migrates an existing development database additively without losing its rows', async () => {
    // The disconnect column arrives by ALTER on a database that already holds
    // accounts. A migration that dropped or rewrote rows would silently sign
    // every existing account out of its own repository choices.
    vi.stubEnv('SESSION_SECRET', 'i'.repeat(32))
    const dbPath = temporaryDatabasePath()
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE github_accounts (
        github_id INTEGER PRIMARY KEY,
        handle TEXT NOT NULL,
        token_iv TEXT NOT NULL,
        token_tag TEXT NOT NULL,
        token_ciphertext TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        tracked_repository_ids_json TEXT NOT NULL,
        auto_include_personal INTEGER NOT NULL,
        auto_include_organizations_json TEXT NOT NULL,
        baseline_by_repository_id_json TEXT NOT NULL,
        last_synced_at TEXT
      )
    `)
    const encrypted = encryptGithubToken('legacy-token', 'i'.repeat(32))
    legacy.exec(`
      INSERT INTO github_accounts (
        github_id, handle, token_iv, token_tag, token_ciphertext, scopes_json,
        tracked_repository_ids_json, auto_include_personal,
        auto_include_organizations_json, baseline_by_repository_id_json,
        last_synced_at
      ) VALUES (
        42, 'octo', '${encrypted.iv}', '${encrypted.tag}', '${encrypted.ciphertext}',
        '["repo"]', '["101"]', 1, '["acme"]',
        '{"101":"2026-01-01T00:00:00.000Z"}', '2026-01-02T00:00:00.000Z'
      )
    `)
    legacy.close()

    // Opening the store runs the additive ALTERs.
    const store = new GithubAccountSqliteStore(dbPath)
    expect(await store.getToken(42)).toBe('legacy-token')
    expect(await store.get(42)).toMatchObject({
      githubId: 42,
      handle: 'octo',
      settings: {
        trackedRepositoryIds: ['101'],
        excludedRepositoryIds: [],
        autoIncludePersonal: true,
        autoIncludeOrganizations: ['acme'],
        baselineByRepositoryId: { '101': '2026-01-01T00:00:00.000Z' },
      },
    })

    // Disconnect migrates the row in place, keeping the choices.
    await store.clearCredential(42)
    expect(await store.getToken(42)).toBeNull()
    expect((await store.getSettings(42)).trackedRepositoryIds).toEqual(['101'])
    expect((await store.getSettings(42)).baselineByRepositoryId).toEqual({})

    // Re-opening must be idempotent: the ALTERs are re-run on every boot.
    const reopened = new GithubAccountSqliteStore(dbPath)
    expect(await reopened.getToken(42)).toBeNull()
    expect((await reopened.get(42))?.handle).toBe('octo')
  })
})
