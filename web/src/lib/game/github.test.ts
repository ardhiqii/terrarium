import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  fetchGithubStats,
  readGithubCache,
  writeGithubCache,
  computeCurrentStreak,
} from './github'
import type { GithubStats } from './types'

/**
 * `github.ts`'s single load-bearing rule: it must NEVER throw. This is a
 * statically-built site, so a thrown fetch takes `npm run build` down with
 * it. Every test below either asserts the return value directly, or wraps
 * the call in `expect(...).not.toThrow()` (async form) to make that
 * contract explicit, not just incidentally true.
 *
 * `fetch` is mocked throughout; no live network calls are made and every
 * test is deterministic offline.
 */

function makeGithubStats(overrides: Partial<GithubStats> = {}): GithubStats {
  return {
    login: 'test-user',
    totalCommits: 3,
    commitsByDay: { '2026-07-01': 3 },
    gardenCommitsByDay: {},
    currentStreakDays: 1,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  }
}

let tmpDir: string
let cachePath: string

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'github-cache-test-'))
  cachePath = path.join(tmpDir, 'github-cache.json')
  vi.restoreAllMocks()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function jsonResponse(body: unknown, init: Partial<Response> & { status?: number } = {}) {
  const status = init.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as Response
}

describe('readGithubCache', () => {
  it('returns null when the cache file does not exist', () => {
    expect(readGithubCache(cachePath)).toBeNull()
  })

  it('round-trips a valid cache write/read', () => {
    const stats = makeGithubStats()
    writeGithubCache(stats, cachePath)
    const read = readGithubCache(cachePath)
    expect(read).toEqual(stats)
  })

  it('returns null (never throws) for a corrupt cache file', () => {
    writeFileSync(cachePath, '{ this is not json', 'utf-8')
    expect(() => readGithubCache(cachePath)).not.toThrow()
    expect(readGithubCache(cachePath)).toBeNull()
  })

  it('returns null for a well-formed JSON file that does not match GithubStats shape', () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ totally: 'wrong', shape: true }),
      'utf-8'
    )
    expect(readGithubCache(cachePath)).toBeNull()
  })

  it('returns null when commitsByDay contains a non-number value', () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        login: 'x',
        totalCommits: 1,
        commitsByDay: { '2026-07-01': 'not-a-number' },
        gardenCommitsByDay: {},
        currentStreakDays: 1,
        fetchedAt: new Date().toISOString(),
      }),
      'utf-8'
    )
    expect(readGithubCache(cachePath)).toBeNull()
  })

  it('treated as no cache when the fetchedAt field is unparsable', () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        login: 'x',
        totalCommits: 1,
        commitsByDay: {},
        gardenCommitsByDay: {},
        currentStreakDays: 0,
        fetchedAt: 'not-a-date',
      }),
      'utf-8'
    )
    expect(readGithubCache(cachePath)).toBeNull()
  })
})

describe('fetchGithubStats: no token configured', () => {
  it('works via the events path and returns stats without throwing', async () => {
    const originalToken = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          type: 'PushEvent',
          created_at: '2026-07-01T12:00:00Z',
          repo: { name: 'test-user/some-repo' },
          payload: { size: 2, distinct_size: 2 },
        },
      ])
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchGithubStats({
      login: 'test-user',
      cachePath,
      apiBase: 'https://fake.invalid',
    })

    expect(result).not.toBeNull()
    expect(result?.commitsByDay['2026-07-01']).toBe(2)
    // Confirms no GraphQL call was attempted with no token: only the
    // events endpoint should have been hit.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('/graphql')
    }

    if (originalToken !== undefined) process.env.GITHUB_TOKEN = originalToken
  })
})

describe('fetchGithubStats: network rejects', () => {
  it('returns null, never throws, when fetch rejects outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network unreachable'))
    )

    await expect(
      fetchGithubStats({ login: 'test-user', cachePath, apiBase: 'https://fake.invalid' })
    ).resolves.toBeNull()
  })

  it('never throws even when fetch itself throws synchronously', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('boom')
      })
    )

    await expect(
      fetchGithubStats({ login: 'test-user', cachePath, apiBase: 'https://fake.invalid' })
    ).resolves.toBeNull()
  })
})

describe('fetchGithubStats: 403 rate-limited', () => {
  it('falls back to a stale cache when rate-limited', async () => {
    const cached = makeGithubStats({
      fetchedAt: new Date(Date.now() - 999999999).toISOString(),
    })
    writeGithubCache(cached, cachePath)

    const headers = new Headers()
    headers.set('x-ratelimit-remaining', '0')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers,
        json: async () => ({ message: 'rate limited' }),
      } as Response)
    )

    const result = await fetchGithubStats({
      login: 'test-user',
      cachePath,
      apiBase: 'https://fake.invalid',
      maxAgeMs: 1, // force the cache to be treated as stale so it refetches
    })

    expect(result).toEqual(cached)
  })

  it('returns null (no throw) when rate-limited and there is no cache to fall back to', async () => {
    const headers = new Headers()
    headers.set('x-ratelimit-remaining', '0')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers,
        json: async () => ({ message: 'rate limited' }),
      } as Response)
    )

    const result = await fetchGithubStats({
      login: 'test-user',
      cachePath,
      apiBase: 'https://fake.invalid',
    })
    expect(result).toBeNull()
  })
})

describe('fetchGithubStats: 404 handle missing', () => {
  it('returns null, with no cache fallback, since a 404 means the login itself is wrong', async () => {
    const cached = makeGithubStats({
      fetchedAt: new Date(Date.now() - 999999999).toISOString(),
    })
    writeGithubCache(cached, cachePath)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: async () => ({ message: 'Not Found' }),
      } as Response)
    )

    const result = await fetchGithubStats({
      login: 'nonexistent-handle',
      cachePath,
      apiBase: 'https://fake.invalid',
      maxAgeMs: 1,
    })
    expect(result).toBeNull()
  })
})

describe('fetchGithubStats: malformed or truncated JSON', () => {
  it('returns null when response.json() throws (malformed/truncated body)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async (): Promise<unknown> => {
          throw new SyntaxError('Unexpected end of JSON input')
        },
      } as Response)
    )

    const result = await fetchGithubStats({
      login: 'test-user',
      cachePath,
      apiBase: 'https://fake.invalid',
    })
    expect(result).toBeNull()
  })

  it('returns null when the events response is valid JSON but not an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ not: 'an array' })))

    const result = await fetchGithubStats({
      login: 'test-user',
      cachePath,
      apiBase: 'https://fake.invalid',
    })
    expect(result).toBeNull()
  })
})

describe('fetchGithubStats: corrupt cache file treated as no cache', () => {
  it('ignores a corrupt on-disk cache and still fetches successfully', async () => {
    writeFileSync(cachePath, 'not valid json {{{', 'utf-8')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([
          {
            type: 'PushEvent',
            created_at: '2026-07-01T12:00:00Z',
            repo: { name: 'test-user/repo' },
            payload: { size: 1 },
          },
        ])
      )
    )

    const result = await fetchGithubStats({
      login: 'test-user',
      cachePath,
      apiBase: 'https://fake.invalid',
    })
    expect(result).not.toBeNull()
    expect(result?.totalCommits).toBe(1)
  })

  it('does not throw and returns null when both the cache is corrupt and the network fails', async () => {
    writeFileSync(cachePath, 'not valid json {{{', 'utf-8')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const result = await fetchGithubStats({
      login: 'test-user',
      cachePath,
      apiBase: 'https://fake.invalid',
    })
    expect(result).toBeNull()
  })
})

describe('fetchGithubStats: GraphQL path with a token', () => {
  it('uses GraphQL when a token is present and returns per-day commit counts', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/graphql')) {
        return jsonResponse({
          data: {
            user: {
              contributionsCollection: {
                commitContributionsByRepository: [
                  {
                    repository: { name: 'the-garden' },
                    contributions: {
                      nodes: [
                        { occurredAt: '2026-07-01T00:00:00Z', commitCount: 5 },
                      ],
                    },
                  },
                ],
              },
            },
          },
        })
      }
      throw new Error('should not hit the events endpoint when GraphQL succeeds')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchGithubStats({
      login: 'test-user',
      token: 'fake-token',
      gardenRepo: 'the-garden',
      cachePath,
      apiBase: 'https://fake.invalid',
    })

    expect(result).not.toBeNull()
    expect(result?.commitsByDay['2026-07-01']).toBe(5)
    expect(result?.gardenCommitsByDay['2026-07-01']).toBe(5)
    expect(result?.totalCommits).toBe(5)
  })

  it('falls through to the events path when the GraphQL response has an errors[] body', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/graphql')) {
        return jsonResponse({
          errors: [{ message: 'Could not resolve to a User with the login of x.' }],
          data: null,
        })
      }
      // Events path.
      return jsonResponse([
        {
          type: 'PushEvent',
          created_at: '2026-07-02T00:00:00Z',
          repo: { name: 'test-user/repo' },
          payload: { size: 1 },
        },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchGithubStats({
      login: 'test-user',
      token: 'fake-token',
      cachePath,
      apiBase: 'https://fake.invalid',
    })

    expect(result).not.toBeNull()
    expect(result?.commitsByDay['2026-07-02']).toBe(1)
    // Both the graphql and the events endpoint should have been attempted.
    const urls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]))
    expect(urls.some((u: string) => u.includes('/graphql'))).toBe(true)
    expect(urls.some((u: string) => u.includes('/events/public'))).toBe(true)
  })

  it('falls through to the events path when GraphQL rejects the network call outright', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/graphql')) {
        throw new Error('network down for graphql')
      }
      return jsonResponse([
        {
          type: 'PushEvent',
          created_at: '2026-07-03T00:00:00Z',
          repo: { name: 'test-user/repo' },
          payload: { size: 1 },
        },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchGithubStats({
      login: 'test-user',
      token: 'fake-token',
      cachePath,
      apiBase: 'https://fake.invalid',
    })
    expect(result).not.toBeNull()
    expect(result?.commitsByDay['2026-07-03']).toBe(1)
  })

  it('falls through to the events path when GraphQL returns malformed/unexpected shape JSON', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/graphql')) {
        return jsonResponse({ data: { user: null } })
      }
      return jsonResponse([
        {
          type: 'PushEvent',
          created_at: '2026-07-04T00:00:00Z',
          repo: { name: 'test-user/repo' },
          payload: { size: 1 },
        },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchGithubStats({
      login: 'test-user',
      token: 'fake-token',
      cachePath,
      apiBase: 'https://fake.invalid',
    })
    expect(result).not.toBeNull()
    expect(result?.commitsByDay['2026-07-04']).toBe(1)
  })
})

describe('fetchGithubStats: cache freshness', () => {
  it('returns the cached value without calling fetch when the cache is still fresh', async () => {
    const fresh = makeGithubStats({ fetchedAt: new Date().toISOString() })
    writeGithubCache(fresh, cachePath)

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchGithubStats({
      login: 'test-user',
      cachePath,
      apiBase: 'https://fake.invalid',
      maxAgeMs: 6 * 60 * 60 * 1000,
    })

    expect(result).toEqual(fresh)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the gardenCommitsByDay <= commitsByDay invariant xp.ts depends on', () => {
  it('holds for events-path output: every gardenCommitsByDay key exists in commitsByDay with a count no larger', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse([
          {
            type: 'PushEvent',
            created_at: '2026-07-05T00:00:00Z',
            repo: { name: 'test-user/the-garden' },
            payload: { size: 3 },
          },
          {
            type: 'PushEvent',
            created_at: '2026-07-05T01:00:00Z',
            repo: { name: 'test-user/other-repo' },
            payload: { size: 2 },
          },
        ])
      )
    )

    const result = await fetchGithubStats({
      login: 'test-user',
      gardenRepo: 'the-garden',
      cachePath,
      apiBase: 'https://fake.invalid',
    })

    expect(result).not.toBeNull()
    for (const [day, gardenCount] of Object.entries(result!.gardenCommitsByDay)) {
      expect(result!.commitsByDay[day]).toBeDefined()
      expect(gardenCount).toBeLessThanOrEqual(result!.commitsByDay[day])
    }
    // Concrete check for this fixture: garden-repo push (3) is a subset of
    // the day total (3 + 2 = 5), not the whole day.
    expect(result!.gardenCommitsByDay['2026-07-05']).toBe(3)
    expect(result!.commitsByDay['2026-07-05']).toBe(5)
  })

  it('holds for GraphQL-path output as well', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/graphql')) {
        return jsonResponse({
          data: {
            user: {
              contributionsCollection: {
                commitContributionsByRepository: [
                  {
                    repository: { name: 'the-garden' },
                    contributions: {
                      nodes: [{ occurredAt: '2026-07-06T00:00:00Z', commitCount: 4 }],
                    },
                  },
                  {
                    repository: { name: 'other-repo' },
                    contributions: {
                      nodes: [{ occurredAt: '2026-07-06T00:00:00Z', commitCount: 6 }],
                    },
                  },
                ],
              },
            },
          },
        })
      }
      throw new Error('unexpected events call')
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchGithubStats({
      login: 'test-user',
      token: 'fake-token',
      gardenRepo: 'the-garden',
      cachePath,
      apiBase: 'https://fake.invalid',
    })

    expect(result).not.toBeNull()
    expect(result!.gardenCommitsByDay['2026-07-06']).toBe(4)
    expect(result!.commitsByDay['2026-07-06']).toBe(10)
    expect(result!.gardenCommitsByDay['2026-07-06']).toBeLessThanOrEqual(
      result!.commitsByDay['2026-07-06']
    )
  })
})

describe('computeCurrentStreak', () => {
  it('returns 0 for an empty commitsByDay', () => {
    expect(computeCurrentStreak({})).toBe(0)
  })

  it('does not throw on malformed keys', () => {
    expect(() => computeCurrentStreak({ 'not-a-date': 5 })).not.toThrow()
  })
})
