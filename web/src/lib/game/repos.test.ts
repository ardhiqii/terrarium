import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fetchOwnerRepos, readRepoListCache, MAX_COLLECTION_REPOS } from './repos'

/**
 * Mirrors github.test.ts's approach: `fetch` is mocked throughout, no live
 * network calls, and the module's "never throws" contract is asserted
 * directly rather than assumed.
 */

let tmpDir: string
let cachePath: string

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'repos-cache-test-'))
  cachePath = path.join(tmpDir, 'repos-cache.json')
  vi.restoreAllMocks()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function ghRepo(overrides: Record<string, unknown> = {}) {
  return {
    name: 'a-repo',
    language: 'TypeScript',
    created_at: '2024-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
    size: 123,
    fork: false,
    ...overrides,
  }
}

describe('fetchOwnerRepos', () => {
  it('returns mapped repo summaries on a successful fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([ghRepo()])))
    const repos = await fetchOwnerRepos({ login: 'octocat', cachePath })
    expect(repos).toEqual([
      {
        name: 'a-repo',
        language: 'TypeScript',
        createdAt: '2024-01-01T00:00:00Z',
        pushedAt: '2026-01-01T00:00:00Z',
        sizeKb: 123,
        fork: false,
      },
    ])
  })

  it('excludes forks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([ghRepo({ name: 'own-repo' }), ghRepo({ name: 'forked-repo', fork: true })])
      )
    )
    const repos = await fetchOwnerRepos({ login: 'octocat', cachePath })
    expect(repos?.map((r) => r.name)).toEqual(['own-repo'])
  })

  it('caps the list at MAX_COLLECTION_REPOS', async () => {
    const many = Array.from({ length: MAX_COLLECTION_REPOS + 10 }, (_, i) =>
      ghRepo({ name: `repo-${i}` })
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(many)))
    const repos = await fetchOwnerRepos({ login: 'octocat', cachePath })
    expect(repos?.length).toBe(MAX_COLLECTION_REPOS)
  })

  it('writes a cache file that a second call reads without refetching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([ghRepo()]))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOwnerRepos({ login: 'octocat', cachePath })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await fetchOwnerRepos({ login: 'octocat', cachePath })
    expect(fetchMock).toHaveBeenCalledTimes(1) // cache hit, no second network call

    const cache = readRepoListCache(cachePath)
    expect(cache?.login).toBe('octocat')
  })

  it('never throws on a network failure, and returns null with no cache to fall back on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(fetchOwnerRepos({ login: 'octocat', cachePath })).resolves.toBeNull()
  })

  it('never throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, 500)))
    await expect(fetchOwnerRepos({ login: 'octocat', cachePath })).resolves.toBeNull()
  })

  it('never throws on a malformed (non-array) response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ not: 'an array' })))
    await expect(fetchOwnerRepos({ login: 'octocat', cachePath })).resolves.toBeNull()
  })

  it('skips array entries with a missing or non-string name rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([ghRepo(), { language: 'Go' }, null]))
    )
    const repos = await fetchOwnerRepos({ login: 'octocat', cachePath })
    expect(repos?.length).toBe(1)
  })
})

describe('readRepoListCache', () => {
  it('returns null when the file does not exist', () => {
    expect(readRepoListCache(path.join(tmpDir, 'missing.json'))).toBeNull()
  })
})
