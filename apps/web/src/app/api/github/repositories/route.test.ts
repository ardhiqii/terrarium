import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  clearGithubRepositoryCache,
  getGithubRepositoriesCached,
} from '@/lib/sync/github-repository-cache'

const mocks = vi.hoisted(() => ({
  session: null as { handle: string; githubId: number; avatarUrl: null } | null,
  settings: {
    trackedRepositoryIds: ['101'],
    excludedRepositoryIds: ['102'],
    autoIncludePersonal: false,
    autoIncludeOrganizations: [] as string[],
    baselineByRepositoryId: {} as Record<string, string>,
    lastSyncedAt: null as string | null,
  },
  getToken: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  clearCredential: vi.fn(),
  fetchRepositories: vi.fn(),
  productStoreRemove: vi.fn(),
}))

vi.mock('@/lib/sync/session', () => ({
  getSessionProvider: () => ({
    current: async () => mocks.session,
  }),
}))

vi.mock('@/lib/sync/github-account-store', () => ({
  getGithubAccountStore: () => ({
    getToken: mocks.getToken,
    getSettings: mocks.getSettings,
    saveSettings: mocks.saveSettings,
    clearCredential: mocks.clearCredential,
  }),
}))

vi.mock('@/lib/sync/github-repositories', () => ({
  fetchGithubRepositories: mocks.fetchRepositories,
}))

// Disconnect must never reach the destructive product-snapshot control; that
// is `DELETE /api/sync/product`, a separate explicit action.
vi.mock('@/lib/sync/product-store', () => ({
  getProductStore: () => ({ remove: mocks.productStoreRemove }),
}))

import { DELETE, GET, PUT } from './route'

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

function request(body: unknown, extraHeaders: HeadersInit = {}): NextRequest {
  return new NextRequest('http://localhost/api/github/repositories', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

function getRequest(query = '', extraHeaders: HeadersInit = {}): NextRequest {
  return new NextRequest(`http://localhost/api/github/repositories${query}`, { headers: extraHeaders })
}

describe('PUT /api/github/repositories', () => {
  beforeEach(() => {
    clearGithubRepositoryCache()
    mocks.session = { handle: 'octo', githubId: 9001, avatarUrl: null }
    mocks.settings = {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: ['102'],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    }
    mocks.getToken.mockReset().mockResolvedValue('server-token')
    mocks.getSettings.mockReset().mockImplementation(async () => mocks.settings)
    mocks.saveSettings.mockReset().mockImplementation(async (_id: number, next: typeof mocks.settings) => {
      mocks.settings = next
    })
    mocks.clearCredential.mockReset().mockResolvedValue(undefined)
    mocks.fetchRepositories.mockReset().mockResolvedValue({ status: 'ok', truncated: false, repositories: [] })
    mocks.productStoreRemove.mockReset().mockResolvedValue(undefined)
  })

  it('rejects a malformed or mismatched account header before loading repository state', async () => {
    const malformed = await GET(getRequest('', { 'x-terrarium-github-id': '9001x' }))
    expect(malformed.status).toBe(409)
    expect(await malformed.json()).toEqual({ error: 'account_changed' })

    const mismatched = await PUT(request({
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }, { 'x-terrarium-github-id': '9002' }))
    expect(mismatched.status).toBe(409)
    expect(await mismatched.json()).toEqual({ error: 'account_changed' })

    const deletion = await DELETE(new NextRequest('http://localhost/api/github/repositories', {
      method: 'DELETE',
      headers: { 'x-terrarium-github-id': '9002' },
    }))
    expect(deletion.status).toBe(409)
    expect(await deletion.json()).toEqual({ error: 'account_changed' })

    expect(mocks.getToken).not.toHaveBeenCalled()
    expect(mocks.fetchRepositories).not.toHaveBeenCalled()
    expect(mocks.saveSettings).not.toHaveBeenCalled()
    expect(mocks.clearCredential).not.toHaveBeenCalled()
  })

  it('reports effective tracking, including automatic personal repositories', async () => {
    mocks.settings.autoIncludePersonal = true
    mocks.settings.trackedRepositoryIds = []
    mocks.fetchRepositories.mockResolvedValue({
      status: 'ok',
      repositories: [
        { id: '101', name: 'garden', fullName: 'octo/garden', ownerLogin: 'octo', ownerType: 'User', private: true, visibility: 'private', defaultBranch: 'main', archived: false, canRead: true },
        { id: '102', name: 'old', fullName: 'octo/old', ownerLogin: 'octo', ownerType: 'User', private: false, visibility: 'public', defaultBranch: 'main', archived: true, canRead: true },
      ],
    })

    const response = await GET(getRequest())

    expect(response.status).toBe(200)
    expect((await response.json()).trackedRepositoryCount).toBe(1)
  })

  it('accepts a matching account header and a missing header for settings writes', async () => {
    const payload = {
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }
    const matching = await PUT(request(payload, { 'x-terrarium-github-id': '9001' }))
    expect(matching.status).toBe(200)

    const missing = await PUT(request(payload))
    expect(missing.status).toBe(200)
  })

  it('drops revoked tracked IDs without blocking an existing exclusion update', async () => {
    const response = await PUT(request({
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: ['102'],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }))

    expect(response.status).toBe(200)
    expect(mocks.settings.trackedRepositoryIds).toEqual([])
    expect(mocks.settings.excludedRepositoryIds).toEqual(['102'])
  })

  it('rejects an oversized body even when the client sends no content-length', async () => {
    // A chunked body carries no content-length, so a size guard that only
    // reads the header is bypassed. The route must bound the actual body.
    const existing = Array.from({ length: 9_000 }, (_, index) => String(100_000 + index))
    mocks.settings.trackedRepositoryIds = existing
    const payload = JSON.stringify({
      trackedRepositoryIds: existing,
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    })
    expect(payload.length).toBeGreaterThan(64 * 1024)

    const response = await PUT(new NextRequest('http://localhost/api/github/repositories', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload))
          controller.close()
        },
      }),
      duplex: 'half',
    }))

    expect(response.status).toBe(413)
  })

  it('still rejects malformed settings and unknown keys before touching GitHub', async () => {
    const malformed = await PUT(request({
      trackedRepositoryIds: '101',
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }))
    expect(malformed.status).toBe(400)

    // JSON.parse keeps `__proto__` as an own enumerable key, so the exact-key
    // check must reject it rather than let it shape the payload.
    const prototypeKey = JSON.parse(
      '{"trackedRepositoryIds":[],"excludedRepositoryIds":[],"autoIncludePersonal":false,"autoIncludeOrganizations":[],"__proto__":{"admin":true}}',
    )
    const polluted = await PUT(request(prototypeKey))
    expect(polluted.status).toBe(400)

    expect(mocks.fetchRepositories).not.toHaveBeenCalled()
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('still rejects a repository that is both tracked and excluded', async () => {
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [repository] })
    const response = await PUT(request({
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: ['101'],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }))

    expect(response.status).toBe(400)
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('does not clear the credential from an automatic failed read', async () => {
    // Disconnect is a user action. A rate limit, a revocation, or a missing
    // session must only ask for a reconnect.
    mocks.fetchRepositories.mockResolvedValue({ status: 'rate-limited', truncated: false, repositories: [] })
    await GET(getRequest())
    mocks.fetchRepositories.mockResolvedValue({ status: 'unauthorized', truncated: false, repositories: [] })
    await GET(getRequest('?refresh=1'))

    expect(mocks.clearCredential).not.toHaveBeenCalled()
  })

  it('still rejects a newly invented repository ID', async () => {
    const response = await PUT(request({
      trackedRepositoryIds: ['999'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }))

    expect(response.status).toBe(400)
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('resets a paused repository baseline when tracking is resumed', async () => {
    mocks.settings = {
      ...mocks.settings,
      trackedRepositoryIds: [],
      baselineByRepositoryId: { '101': '2026-01-01T00:00:00.000Z' },
    }
    mocks.fetchRepositories.mockResolvedValue({
      status: 'ok',
      repositories: [{ id: '101', name: 'garden', fullName: 'octo/garden', ownerLogin: 'octo', ownerType: 'User', private: true, visibility: 'private', defaultBranch: 'main', archived: false, canRead: true }],
    })

    const response = await PUT(request({
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }))

    expect(response.status).toBe(200)
    expect(mocks.settings.baselineByRepositoryId).toEqual({})
  })

  it('reuses the listing a page load just fetched instead of re-listing for a save', async () => {
    // REGRESSION: opening the picker and saving choices used to cost ten
    // GitHub requests (two listings), which is what drained the account's
    // hourly budget and produced the rate-limit wall.
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [repository] })
    await GET(getRequest())

    const response = await PUT(request({
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }))

    expect(response.status).toBe(200)
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(1)
    expect((await response.json()).stale).toBe(false)
  })

  it('keeps an existing tracked id that is absent from a truncated listing', async () => {
    // A listing that filled the last page is not proof the repository is gone.
    // Unselecting it would silently stop tracking a source the user chose.
    mocks.settings.trackedRepositoryIds = ['101', '501']
    mocks.fetchRepositories.mockResolvedValue({
      status: 'ok',
      repositories: [repository],
      truncated: true,
    })

    const response = await PUT(request({
      trackedRepositoryIds: ['101', '501'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }))

    expect(response.status).toBe(200)
    expect(mocks.settings.trackedRepositoryIds).toEqual(['101', '501'])
  })

  it('keeps an existing tracked id that is absent from a stale listing', async () => {
    mocks.settings.trackedRepositoryIds = ['101', '501']
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [repository] })
    await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'server-token',
      // Past the fresh window so the save revalidates, then falls back.
      now: Date.now() - 10 * 60 * 1000,
    })
    mocks.fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })

    const response = await PUT(request({
      trackedRepositoryIds: ['101', '501'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
    }))

    expect(response.status).toBe(200)
    expect(mocks.settings.trackedRepositoryIds).toEqual(['101', '501'])
  })
})

describe('GET /api/github/repositories', () => {
  beforeEach(() => {
    clearGithubRepositoryCache()
    mocks.session = { handle: 'octo', githubId: 9001, avatarUrl: null }
    mocks.settings = {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: ['102'],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    }
    mocks.getToken.mockReset().mockResolvedValue('server-token')
    mocks.getSettings.mockReset().mockImplementation(async () => mocks.settings)
    mocks.saveSettings.mockReset()
    mocks.clearCredential.mockReset().mockResolvedValue(undefined)
    mocks.fetchRepositories.mockReset().mockResolvedValue({ status: 'ok', truncated: false, repositories: [repository] })
  })

  it('accepts a matching account header on repository reads', async () => {
    const response = await GET(getRequest('', { 'x-terrarium-github-id': '9001' }))

    expect(response.status).toBe(200)
  })

  it('serves a repeated GET from the server cache without calling GitHub again', async () => {
    const first = await GET(getRequest())
    const second = await GET(getRequest())

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(1)
    const firstBody = await first.json()
    const secondBody = await second.json()
    expect(firstBody.repositories).toEqual([repository])
    expect(secondBody.repositories).toEqual([repository])
    expect(typeof secondBody.fetchedAt).toBe('number')
    expect(secondBody.stale).toBe(false)
    expect(secondBody.trackedRepositoryCount).toBe(1)
  })

  it('ignores refresh values that are not the documented flag', async () => {
    await GET(getRequest())
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(1)

    for (const query of ['', '?refresh', '?refresh=', '?refresh=0', '?refresh=yes', '?refresh[]=1', '?Refresh=1']) {
      const response = await GET(getRequest(query))
      expect(response.status).toBe(200)
    }

    // None of those may bypass the fresh cache entry and spend five more
    // GitHub requests.
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(1)
  })

  it('revalidates when the client asks for a refresh', async () => {
    await GET(getRequest())
    const refreshed = await GET(getRequest('?refresh=1'))

    expect(refreshed.status).toBe(200)
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(2)
    expect((await refreshed.json()).stale).toBe(false)
  })

  it('serves the cached listing marked stale when a refresh is rate limited', async () => {
    const first = await GET(getRequest())
    expect((await first.json()).stale).toBe(false)

    mocks.fetchRepositories.mockResolvedValue({ status: 'rate-limited', truncated: false, repositories: [] })
    const degraded = await GET(getRequest('?refresh=1'))

    // Not a 429 with zero repositories: the picker keeps working and says so.
    expect(degraded.status).toBe(200)
    const body = await degraded.json()
    expect(body.stale).toBe(true)
    expect(body.repositories).toEqual([repository])
    expect(body.settings).toEqual({
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: ['102'],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      lastSyncedAt: null,
    })
  })

  it('reports the original read time on a stale listing so the client cannot label it fresh', async () => {
    // A degraded listing is not a new read. If the route stamped `fetchedAt`
    // with `now`, the picker would persist it as a listing read seconds ago
    // and the freshness label would lie.
    const readAt = Date.now() - 10 * 60 * 1000
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [repository] })
    await getGithubRepositoriesCached({ githubId: 9001, token: 'server-token', now: readAt })

    mocks.fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })
    const degraded = await GET(getRequest('?refresh=1'))

    expect(degraded.status).toBe(200)
    const body = await degraded.json()
    expect(body.stale).toBe(true)
    expect(body.fetchedAt).toBe(readAt)
  })

  it('still answers 429 and 502 when nothing is cached to degrade to', async () => {
    mocks.fetchRepositories.mockResolvedValue({ status: 'rate-limited', truncated: false, repositories: [] })
    const rateLimited = await GET(getRequest())
    expect(rateLimited.status).toBe(429)
    expect(String((await rateLimited.json()).error)).toContain('rate limit')

    mocks.fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })
    const unavailable = await GET(getRequest('?refresh=1'))
    expect(unavailable.status).toBe(502)
  })

  it('names the account on a failed read so the client can discard a foreign browser copy', async () => {
    // A shared browser profile can hold account A's listing while account B is
    // signed in. The failure body carries the account the server actually
    // answered for, so the client never falls back to A's private repo names.
    mocks.fetchRepositories.mockResolvedValue({ status: 'rate-limited', truncated: false, repositories: [] })
    const rateLimited = await GET(getRequest())
    expect(rateLimited.status).toBe(429)
    expect((await rateLimited.json()).githubId).toBe(9001)

    mocks.fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })
    const unavailable = await GET(getRequest('?refresh=1'))
    expect(unavailable.status).toBe(502)
    expect((await unavailable.json()).githubId).toBe(9001)
  })

  it('purges the cache on a 401 so a revoked listing is never served', async () => {
    await GET(getRequest())
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(1)

    mocks.fetchRepositories.mockResolvedValue({ status: 'unauthorized', truncated: false, repositories: [] })
    const revoked = await GET(getRequest('?refresh=1'))
    expect(revoked.status).toBe(401)

    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [repository] })
    const after = await GET(getRequest())
    expect(after.status).toBe(200)
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(3)
  })

  it('reports 401 when the session is gone', async () => {
    mocks.session = null
    const response = await GET(getRequest())

    expect(response.status).toBe(401)
    expect(mocks.fetchRepositories).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/github/repositories', () => {
  beforeEach(() => {
    clearGithubRepositoryCache()
    mocks.session = { handle: 'octo', githubId: 9001, avatarUrl: null }
    mocks.settings = {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: ['102'],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    }
    mocks.getToken.mockReset().mockResolvedValue('server-token')
    mocks.getSettings.mockReset().mockImplementation(async () => mocks.settings)
    mocks.saveSettings.mockReset()
    mocks.clearCredential.mockReset().mockResolvedValue(undefined)
    mocks.fetchRepositories.mockReset().mockResolvedValue({ status: 'ok', truncated: false, repositories: [repository] })
    mocks.productStoreRemove.mockReset().mockResolvedValue(undefined)
  })

  it('refuses to disconnect without a session', async () => {
    mocks.session = null
    const response = await DELETE()

    expect(response.status).toBe(401)
    expect(mocks.clearCredential).not.toHaveBeenCalled()
    expect(mocks.productStoreRemove).not.toHaveBeenCalled()
  })

  it('accepts a matching account header on disconnect', async () => {
    const response = await DELETE(new NextRequest('http://localhost/api/github/repositories', {
      method: 'DELETE',
      headers: { 'x-terrarium-github-id': '9001' },
    }))

    expect(response.status).toBe(204)
  })

  it('clears only the credential, purges the listing cache, and keeps selections', async () => {
    // Warm the cache so the purge is observable.
    await GET(getRequest())
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(1)

    const response = await DELETE()

    expect(response.status).toBe(204)
    expect(mocks.clearCredential).toHaveBeenCalledTimes(1)
    expect(mocks.clearCredential).toHaveBeenCalledWith(9001)
    // Selections are not rewritten, and the destructive product-snapshot
    // control is a different endpoint entirely.
    expect(mocks.saveSettings).not.toHaveBeenCalled()
    expect(mocks.productStoreRemove).not.toHaveBeenCalled()

    const after = await GET(getRequest())
    expect(after.status).toBe(200)
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(2)
  })

  it('answers 500 instead of throwing when the store fails', async () => {
    mocks.clearCredential.mockRejectedValue(new Error('offline'))
    const response = await DELETE()

    expect(response.status).toBe(500)
  })
})
