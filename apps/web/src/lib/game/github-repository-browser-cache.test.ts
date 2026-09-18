import { describe, expect, it } from 'vitest'
import {
  GITHUB_REPOSITORY_CACHE_FRESH_MS,
  GITHUB_REPOSITORY_CACHE_KEY,
  GITHUB_REPOSITORY_CACHE_MAX_BYTES,
  cachedGithubRepositoryMatchesAccount,
  clearGithubRepositoryCache,
  decideFailedListingRefresh,
  githubRepositoryCacheAgeMs,
  isGithubRepositoryCacheFresh,
  loadGithubRepositoryCache,
  saveGithubRepositoryCache,
  type GithubRepositoryCacheEntry,
} from './github-repository-browser-cache'

/** Map-backed stand-in for localStorage; can be told to refuse writes. */
class FakeStorage {
  readonly values = new Map<string, string>()
  failWrites = false

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const repository = {
  id: '101',
  name: 'garden',
  fullName: 'octo/garden',
  ownerLogin: 'octo',
  ownerType: 'User' as const,
  private: true,
  visibility: 'private',
  defaultBranch: 'main',
  archived: false,
  canRead: true,
}

function entry(overrides: Partial<GithubRepositoryCacheEntry> = {}): GithubRepositoryCacheEntry {
  return {
    githubId: 9001,
    savedAt: 1_000_000,
    repositories: [repository],
    settings: {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      lastSyncedAt: null,
    },
    approvedRepositoryCount: 1,
    trackedRepositoryCount: 1,
    ...overrides,
  }
}

describe('github repository browser cache', () => {
  it('round-trips a listing through storage', () => {
    const storage = new FakeStorage()

    expect(saveGithubRepositoryCache(storage, entry())).toBe(true)
    expect(loadGithubRepositoryCache(storage)).toEqual(entry())
  })

  it('reports age and freshness against the five-minute window', () => {
    const storage = new FakeStorage()
    saveGithubRepositoryCache(storage, entry())
    const stored = loadGithubRepositoryCache(storage)
    expect(stored).not.toBeNull()

    const freshAt = 1_000_000 + GITHUB_REPOSITORY_CACHE_FRESH_MS - 1
    expect(githubRepositoryCacheAgeMs(stored!, freshAt)).toBe(GITHUB_REPOSITORY_CACHE_FRESH_MS - 1)
    expect(isGithubRepositoryCacheFresh(stored!, freshAt)).toBe(true)

    const staleAt = 1_000_000 + GITHUB_REPOSITORY_CACHE_FRESH_MS
    expect(isGithubRepositoryCacheFresh(stored!, staleAt)).toBe(false)
    // A clock that moved backwards must not report negative age.
    expect(githubRepositoryCacheAgeMs(stored!, 500_000)).toBe(0)
  })

  it('ignores corrupt JSON instead of throwing', () => {
    const storage = new FakeStorage()
    storage.setItem(GITHUB_REPOSITORY_CACHE_KEY, '{not json')

    expect(loadGithubRepositoryCache(storage)).toBeNull()
  })

  it('ignores a stored value that is not a listing', () => {
    const storage = new FakeStorage()
    storage.setItem(GITHUB_REPOSITORY_CACHE_KEY, JSON.stringify({ githubId: 9001, repositories: 'nope' }))
    expect(loadGithubRepositoryCache(storage)).toBeNull()

    storage.setItem(GITHUB_REPOSITORY_CACHE_KEY, JSON.stringify(['not-an-entry']))
    expect(loadGithubRepositoryCache(storage)).toBeNull()

    storage.setItem(GITHUB_REPOSITORY_CACHE_KEY, JSON.stringify(entry({ settings: null as never })))
    expect(loadGithubRepositoryCache(storage)).toBeNull()
  })

  it('drops unreadable repositories but keeps the readable ones', () => {
    const storage = new FakeStorage()
    saveGithubRepositoryCache(storage, entry({
      repositories: [repository, { id: 'broken' } as never],
    }))

    expect(loadGithubRepositoryCache(storage)?.repositories).toEqual([repository])
  })

  it('skips an oversized write so one payload cannot fill browser storage', () => {
    const storage = new FakeStorage()
    const huge = {
      ...repository,
      name: 'x'.repeat(GITHUB_REPOSITORY_CACHE_MAX_BYTES),
      fullName: `octo/${'x'.repeat(GITHUB_REPOSITORY_CACHE_MAX_BYTES)}`,
    }

    expect(saveGithubRepositoryCache(storage, entry({ repositories: [huge] }))).toBe(false)
    expect(storage.getItem(GITHUB_REPOSITORY_CACHE_KEY)).toBeNull()
  })

  it('swallows a refused write and reports it as not stored', () => {
    const storage = new FakeStorage()
    storage.failWrites = true

    expect(saveGithubRepositoryCache(storage, entry())).toBe(false)
  })

  it('discards a copy stored for a different GitHub account', () => {
    // One browser profile can be shared by two GitHub accounts. Account A's
    // listing (private repository names included) must never be painted for
    // account B just because B's first refresh failed.
    const storage = new FakeStorage()
    saveGithubRepositoryCache(storage, entry({ githubId: 9001 }))

    expect(loadGithubRepositoryCache(storage, 9002)).toBeNull()
    expect(loadGithubRepositoryCache(storage, 9001)?.githubId).toBe(9001)
    // No expectation means the first paint of an unknown session, which is
    // replaced by the server response; the stored id is still returned there.
    expect(loadGithubRepositoryCache(storage)?.githubId).toBe(9001)
  })

  it('only treats a stored listing as showable when the account is confirmed', () => {
    const stored = entry({ githubId: 9001 })

    expect(cachedGithubRepositoryMatchesAccount(stored, 9001)).toBe(true)
    expect(cachedGithubRepositoryMatchesAccount(stored, 9002)).toBe(false)
    // An unknown account is not confirmation: a shared profile may hold
    // another account's copy.
    expect(cachedGithubRepositoryMatchesAccount(stored, null)).toBe(false)
    expect(cachedGithubRepositoryMatchesAccount(null, 9001)).toBe(false)
  })

  it('refuses to replace a newer stored listing with an older read', () => {
    // The panel stores `savedAt` as the time the SERVER read the listing, so a
    // degraded response can legitimately carry an older timestamp than the
    // copy already on disk. A one-slot cache must not let that overwrite the
    // newer listing: the freshness label would regress and a later failed
    // refresh would fall back to the older one.
    const storage = new FakeStorage()
    const newer = { ...repository, id: '202', name: 'newer-garden', fullName: 'octo/newer-garden' }
    saveGithubRepositoryCache(storage, entry({ savedAt: 2_000_000, repositories: [newer] }))

    const stored = saveGithubRepositoryCache(storage, entry({
      savedAt: 1_000_000,
      repositories: [repository],
      settings: {
        trackedRepositoryIds: ['101', '202'],
        excludedRepositoryIds: [],
        autoIncludePersonal: true,
        autoIncludeOrganizations: [],
        lastSyncedAt: null,
      },
    }))

    expect(stored).toBe(true)
    const loaded = loadGithubRepositoryCache(storage)
    expect(loaded?.savedAt).toBe(2_000_000)
    expect(loaded?.repositories).toEqual([newer])
    // The incoming settings were read from the server at request time, so they
    // are newer than the listing and still win.
    expect(loaded?.settings.trackedRepositoryIds).toEqual(['101', '202'])
    expect(loaded?.settings.autoIncludePersonal).toBe(true)
  })

  it('lets a different account replace the slot even with an older read time', () => {
    const storage = new FakeStorage()
    saveGithubRepositoryCache(storage, entry({ githubId: 9001, savedAt: 2_000_000 }))

    expect(saveGithubRepositoryCache(storage, entry({ githubId: 9002, savedAt: 1_000_000 }))).toBe(true)
    expect(loadGithubRepositoryCache(storage)?.githubId).toBe(9002)
  })

  it('only lets a listing survive a failed refresh when it matches the account that answered', () => {
    // Multi-tab profile: the panel confirmed account A earlier in this mount,
    // then the session became account B. A failed read answered for B must not
    // keep A's private repository names on screen just because A was confirmed
    // once.
    const stored = entry({ githubId: 9001 })

    expect(decideFailedListingRefresh({ cached: stored, confirmedGithubId: 9001, failedGithubId: 9001 }))
      .toBe('keep-listing')
    expect(decideFailedListingRefresh({ cached: stored, confirmedGithubId: null, failedGithubId: 9001 }))
      .toBe('keep-listing')
    // A failure that names no account is unattributable: our 500 body carries
    // no githubId, and the session may have changed under the mount.
    expect(decideFailedListingRefresh({ cached: stored, confirmedGithubId: 9001, failedGithubId: null }))
      .toBe('fail-load')

    expect(decideFailedListingRefresh({ cached: stored, confirmedGithubId: 9001, failedGithubId: 9002 }))
      .toBe('drop-listing')
    // An unconfirmed copy painted on first paint is not proof it belongs here.
    expect(decideFailedListingRefresh({ cached: stored, confirmedGithubId: null, failedGithubId: 9002 }))
      .toBe('fail-load')
    expect(decideFailedListingRefresh({ cached: stored, confirmedGithubId: null, failedGithubId: null }))
      .toBe('fail-load')
  })

  it('clears the stored entry and tolerates a refused removal', () => {
    const storage = new FakeStorage()
    saveGithubRepositoryCache(storage, entry())
    clearGithubRepositoryCache(storage)
    expect(loadGithubRepositoryCache(storage)).toBeNull()

    const refusing = new FakeStorage()
    refusing.removeItem = () => { throw new Error('nope') }
    expect(() => clearGithubRepositoryCache(refusing)).not.toThrow()
  })
})
