import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getFollowing, clearFollowingCache } from './github-following'

/**
 * `github-following.ts`'s one load-bearing rule, same as `github.ts`: it
 * must never throw. `fetch` is mocked throughout; no live network calls.
 */

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as Response
}

function userList(logins: string[]) {
  return logins.map((login) => ({ login }))
}

beforeEach(() => {
  clearFollowingCache()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getFollowing', () => {
  it('returns lowercased logins for a normal response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(userList(['Mattt', 'RAUCHG']))))
    const result = await getFollowing('sindresorhus', { apiBase: 'https://fake' })
    expect(result).toEqual(['mattt', 'rauchg'])
  })

  it('paginates until a short page is returned', async () => {
    const page1 = userList(Array.from({ length: 100 }, (_, i) => `user${i}`))
    const page2 = userList(['last-user'])
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2))
    vi.stubGlobal('fetch', fetchMock)
    const result = await getFollowing('someone', { apiBase: 'https://fake' })
    expect(result).toHaveLength(101)
    expect(result).toContain('last-user')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns [] and never throws on a network failure, with no cache to fall back to', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(getFollowing('someone', { apiBase: 'https://fake' })).resolves.toEqual([])
  })

  it('returns [] on a 404 (handle does not exist)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 })))
    const result = await getFollowing('ghost', { apiBase: 'https://fake' })
    expect(result).toEqual([])
  })

  it('falls back to the last good cache on a rate limit (403)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(userList(['friend'])))
      .mockResolvedValueOnce(jsonResponse({}, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await getFollowing('someone', { apiBase: 'https://fake', maxAgeMs: 0 })
    expect(first).toEqual(['friend'])

    const second = await getFollowing('someone', { apiBase: 'https://fake', maxAgeMs: 0 })
    expect(second).toEqual(['friend'])
  })

  it('returns [] on malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error('bad json')
        },
      } as unknown as Response)
    )
    const result = await getFollowing('someone', { apiBase: 'https://fake' })
    expect(result).toEqual([])
  })

  it('returns [] when the response body is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ not: 'an array' })))
    const result = await getFollowing('someone', { apiBase: 'https://fake' })
    expect(result).toEqual([])
  })

  it('serves from cache within maxAgeMs without calling fetch again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(userList(['a'])))
    vi.stubGlobal('fetch', fetchMock)
    await getFollowing('someone', { apiBase: 'https://fake', maxAgeMs: 60_000 })
    await getFollowing('someone', { apiBase: 'https://fake', maxAgeMs: 60_000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns [] for an empty login', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const result = await getFollowing('', { apiBase: 'https://fake' })
    expect(result).toEqual([])
  })
})
