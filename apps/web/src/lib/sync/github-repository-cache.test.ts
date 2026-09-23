import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GITHUB_REPOSITORY_CACHE_FRESH_MS,
  GITHUB_REPOSITORY_CACHE_MAX_ENTRIES,
  GITHUB_REPOSITORY_CACHE_RETENTION_MS,
  clearGithubRepositoryCache,
  getGithubRepositoriesCached,
  githubRepositoryCacheSize,
  purgeGithubRepositoryCache,
  type GithubRepositoriesProvider,
} from './github-repository-cache'
import type { GithubRepository, GithubRepositoryFetchResult } from './github-repositories'

const START = 1_700_000_000_000

const repository: GithubRepository = {
  id: '101',
  name: 'garden',
  fullName: 'octo/garden',
  ownerLogin: 'octo',
  ownerType: 'User',
  private: true,
  visibility: 'private',
  defaultBranch: 'main',
  archived: false,
  canRead: true,
}

function provider(result: GithubRepositoryFetchResult) {
  return vi.fn<GithubRepositoriesProvider>(async () => result)
}

function ok(
  repositories: readonly GithubRepository[] = [repository],
  truncated = false,
): GithubRepositoryFetchResult {
  return { status: 'ok', repositories, truncated }
}

describe('server-side github repository cache', () => {
  beforeEach(() => {
    clearGithubRepositoryCache()
  })

  it('serves a fresh entry without calling the provider at all', async () => {
    const fetchRepositories = provider(ok())

    const first = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START,
      fetchRepositories,
    })
    const second = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + GITHUB_REPOSITORY_CACHE_FRESH_MS - 1,
      fetchRepositories,
    })

    expect(fetchRepositories).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ fetchedAt: START, stale: false })
    expect(second).toMatchObject({ fetchedAt: START, stale: false })
    expect(second.result.repositories).toEqual([repository])
  })

  it('revalidates once the fresh window has passed', async () => {
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })

    const nextRepository = { ...repository, id: '202', name: 'new-garden' }
    fetchRepositories.mockResolvedValue(ok([nextRepository]))
    const refreshed = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + GITHUB_REPOSITORY_CACHE_FRESH_MS,
      fetchRepositories,
    })

    expect(fetchRepositories).toHaveBeenCalledTimes(2)
    expect(refreshed).toMatchObject({ fetchedAt: START + GITHUB_REPOSITORY_CACHE_FRESH_MS, stale: false })
    expect(refreshed.result.repositories).toEqual([nextRepository])
  })

  it('revalidates on demand when forced, even inside the fresh window', async () => {
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })

    await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      force: true,
      now: START + 1,
      fetchRepositories,
    })

    expect(fetchRepositories).toHaveBeenCalledTimes(2)
  })

  it('serves the last listing marked stale when the provider is rate limited', async () => {
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })

    fetchRepositories.mockResolvedValue({ status: 'rate-limited', truncated: false, repositories: [] })
    const stale = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + GITHUB_REPOSITORY_CACHE_FRESH_MS + 1000,
      fetchRepositories,
    })

    expect(stale.stale).toBe(true)
    expect(stale.fetchedAt).toBe(START)
    expect(stale.result.status).toBe('ok')
    expect(stale.result.repositories).toEqual([repository])
  })

  it('serves the last listing marked stale when the provider is unavailable', async () => {
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })

    fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })
    const stale = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      force: true,
      now: START + 1000,
      fetchRepositories,
    })

    expect(stale).toMatchObject({ stale: true, fetchedAt: START })
    expect(stale.result.repositories).toEqual([repository])
  })

  it('propagates a failure untouched when nothing is cached', async () => {
    const fetchRepositories = provider({ status: 'rate-limited', truncated: false, repositories: [] })
    const result = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START,
      fetchRepositories,
    })

    expect(result.result.status).toBe('rate-limited')
    expect(result.stale).toBe(false)
    expect(result.result.repositories).toEqual([])
  })

  it('purges on unauthorized and never serves the listing stale', async () => {
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })

    fetchRepositories.mockResolvedValue({ status: 'unauthorized', truncated: false, repositories: [] })
    const revoked = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + GITHUB_REPOSITORY_CACHE_FRESH_MS + 1000,
      fetchRepositories,
    })
    expect(revoked.result.status).toBe('unauthorized')
    expect(revoked.stale).toBe(false)

    // The purge is real: a later failure has nothing left to fall back to.
    fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })
    const after = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + GITHUB_REPOSITORY_CACHE_FRESH_MS + 2000,
      fetchRepositories,
    })
    expect(after.result.status).toBe('unavailable')
  })

  it('shares one provider read between concurrent reads for the same account', async () => {
    // Two tabs (or the picker and a sync) can hit a stale entry at the same
    // moment. Revalidating twice spends up to ten GitHub requests for one
    // listing, which is the budget drain this cache exists to stop.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchRepositories = vi.fn<GithubRepositoriesProvider>(async () => {
      await gate
      return ok()
    })

    const first = getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START,
      fetchRepositories,
    })
    const second = getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      force: true,
      now: START,
      fetchRepositories,
    })
    release()
    const [a, b] = await Promise.all([first, second])

    expect(fetchRepositories).toHaveBeenCalledTimes(1)
    expect(a.result.repositories).toEqual([repository])
    expect(b.result.repositories).toEqual([repository])
  })

  it('keeps concurrent reads for different accounts independent', async () => {
    const fetchRepositories = vi.fn<GithubRepositoriesProvider>(async () => ok())
    await Promise.all([
      getGithubRepositoriesCached({ githubId: 1, token: 't', now: START, fetchRepositories }),
      getGithubRepositoriesCached({ githubId: 2, token: 't', now: START, fetchRepositories }),
    ])
    expect(fetchRepositories).toHaveBeenCalledTimes(2)
  })

  it('keeps a backwards clock from serving an expired entry as fresh forever', async () => {
    // A clock correction (NTP, container pause) can move `now` behind the
    // entry's timestamp. A negative age must not make the fresh window last
    // until the clock catches up: the entry is revalidated instead.
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })
    await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START - GITHUB_REPOSITORY_CACHE_RETENTION_MS,
      fetchRepositories,
    })

    expect(fetchRepositories).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect a purged listing when an in-flight read completes afterwards', async () => {
    // Disconnect purges the cache while a refresh may still be reading from
    // GitHub. The read that lands after the purge must not re-insert the
    // listing: the credential it belonged to is gone.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchRepositories = vi.fn<GithubRepositoriesProvider>(async () => {
      await gate
      return ok()
    })

    const pending = getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START,
      fetchRepositories,
    })
    purgeGithubRepositoryCache(9001)
    release()
    await pending

    // The next read goes back to the provider instead of being served from a
    // listing the purge was supposed to have removed.
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START + 1, fetchRepositories })
    expect(fetchRepositories).toHaveBeenCalledTimes(2)
  })

  it('drops an entry past the retention ceiling instead of serving it', async () => {
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })

    fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })
    const expired = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + GITHUB_REPOSITORY_CACHE_RETENTION_MS,
      fetchRepositories,
    })

    expect(expired.result.status).toBe('unavailable')
    expect(expired.stale).toBe(false)
  })

  it('keeps accounts isolated from each other', async () => {
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })

    fetchRepositories.mockResolvedValue(ok([{ ...repository, id: '999', name: 'other' }]))
    const other = await getGithubRepositoriesCached({
      githubId: 9002,
      token: 'token-b',
      now: START,
      fetchRepositories,
    })

    expect(fetchRepositories).toHaveBeenCalledTimes(2)
    expect(other.result.repositories.map((entry) => entry.id)).toEqual(['999'])

    // Purging one account leaves the other's entry alone.
    purgeGithubRepositoryCache(9002)
    const stillCached = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + 1000,
      fetchRepositories,
    })
    expect(fetchRepositories).toHaveBeenCalledTimes(2)
    expect(stillCached.result.repositories.map((entry) => entry.id)).toEqual(['101'])
  })

  it('caches a legitimately empty listing instead of hammering GitHub', async () => {
    const fetchRepositories = provider(ok([]))
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })
    const second = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + 1000,
      fetchRepositories,
    })

    expect(fetchRepositories).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ stale: false })
    expect(second.result.repositories).toEqual([])
  })

  it('keeps the truncated flag on a cached listing so it is never treated as complete', async () => {
    const fetchRepositories = provider(ok([repository], true))

    const first = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START,
      fetchRepositories,
    })
    const second = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + GITHUB_REPOSITORY_CACHE_FRESH_MS - 1,
      fetchRepositories,
    })

    expect(fetchRepositories).toHaveBeenCalledTimes(1)
    expect(first.result.truncated).toBe(true)
    expect(second.result.truncated).toBe(true)
    expect(second.result.repositories).toEqual([repository])
  })

  it('sweeps expired entries when a new listing is stored', async () => {
    // Retention was only enforced for the account being requested, so a
    // listing nobody asked for again stayed in memory until restart.
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 1, token: 't', now: START, fetchRepositories })
    await getGithubRepositoriesCached({ githubId: 2, token: 't', now: START, fetchRepositories })
    expect(githubRepositoryCacheSize()).toBe(2)

    await getGithubRepositoriesCached({
      githubId: 3,
      token: 't',
      now: START + GITHUB_REPOSITORY_CACHE_RETENTION_MS,
      fetchRepositories,
    })

    expect(githubRepositoryCacheSize()).toBe(1)
    // Account 1 is gone, so it goes back to GitHub instead of being served
    // from a map entry that never expired on its own.
    await getGithubRepositoriesCached({
      githubId: 1,
      token: 't',
      now: START + GITHUB_REPOSITORY_CACHE_RETENTION_MS,
      fetchRepositories,
    })
    expect(fetchRepositories).toHaveBeenCalledTimes(4)
  })

  it('caps the number of retained accounts and evicts the oldest', async () => {
    const fetchRepositories = provider(ok())
    for (let githubId = 0; githubId <= GITHUB_REPOSITORY_CACHE_MAX_ENTRIES; githubId += 1) {
      await getGithubRepositoriesCached({
        githubId,
        token: 't',
        now: START + githubId,
        fetchRepositories,
      })
    }

    expect(githubRepositoryCacheSize()).toBe(GITHUB_REPOSITORY_CACHE_MAX_ENTRIES)
  })

  it('never caches a partial or failed listing over a good one', async () => {
    const fetchRepositories = provider(ok())
    await getGithubRepositoriesCached({ githubId: 9001, token: 'token-a', now: START, fetchRepositories })

    fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })
    const firstFailure = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + GITHUB_REPOSITORY_CACHE_FRESH_MS + 1,
      fetchRepositories,
    })
    expect(firstFailure.stale).toBe(true)
    expect(firstFailure.fetchedAt).toBe(START)

    // A second failure still reports the ORIGINAL fetch time, proving the
    // failure did not overwrite the cached entry.
    const secondFailure = await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'token-a',
      now: START + GITHUB_REPOSITORY_CACHE_FRESH_MS + 2000,
      fetchRepositories,
    })
    expect(secondFailure.stale).toBe(true)
    expect(secondFailure.fetchedAt).toBe(START)
  })
})
