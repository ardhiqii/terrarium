import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
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
  fetchRepositories: vi.fn(),
}))

vi.mock('@/lib/sync/session', () => ({
  getSessionProvider: () => ({
    current: async () => ({ handle: 'octo', githubId: 9001, avatarUrl: null }),
  }),
}))

vi.mock('@/lib/sync/github-account-store', () => ({
  getGithubAccountStore: () => ({
    getToken: mocks.getToken,
    getSettings: mocks.getSettings,
    saveSettings: mocks.saveSettings,
  }),
}))

vi.mock('@/lib/sync/github-repositories', () => ({
  fetchGithubRepositories: mocks.fetchRepositories,
}))

import { GET, PUT } from './route'

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/github/repositories', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('PUT /api/github/repositories', () => {
  beforeEach(() => {
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
    mocks.fetchRepositories.mockReset().mockResolvedValue({ status: 'ok', repositories: [] })
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

    const response = await GET()

    expect(response.status).toBe(200)
    expect((await response.json()).trackedRepositoryCount).toBe(1)
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
})
