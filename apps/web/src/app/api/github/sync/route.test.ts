import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { verifyGithubSyncCheckpoint } from '@/lib/sync/github-sync-checkpoint'

const mocks = vi.hoisted(() => ({
  settings: {
    trackedRepositoryIds: ['101'],
    excludedRepositoryIds: [] as string[],
    autoIncludePersonal: false,
    autoIncludeOrganizations: [] as string[],
    baselineByRepositoryId: {} as Record<string, string>,
    lastSyncedAt: null as string | null,
  },
  getToken: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  fetchRepositories: vi.fn(),
  fetchEvents: vi.fn(),
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

vi.mock('@/lib/game/github-events-fetch', () => ({
  fetchGitHubEvents: mocks.fetchEvents,
}))

import { POST } from './route'

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

function request(): NextRequest {
  return new NextRequest('http://localhost/api/github/sync', {
    method: 'POST',
    body: JSON.stringify({ activeCompanionId: 'pikachu-family' }),
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Reads the newline-delimited JSON a long sync streams. Pre-flight failures and
 * the no-repositories path still answer with ordinary JSON, so this handles both.
 */
async function readSyncEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Extracts the final result payload from a streamed sync response. */
async function readSyncBody(response: Response): Promise<Record<string, unknown>> {
  const events = await readSyncEvents(response)
  const result = events.find((event) => event.type === 'result')
  if (!result) {
    const failure = events.find((event) => event.type === 'error')
    throw new Error(`Sync failed: ${String(failure?.error ?? 'no result payload')}`)
  }
  return result.payload as Record<string, unknown>
}

describe('POST /api/github/sync', () => {
  beforeEach(() => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    mocks.settings = {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    }
    mocks.getToken.mockReset().mockResolvedValue('server-token')
    mocks.getSettings.mockReset().mockImplementation(async () => mocks.settings)
    mocks.saveSettings.mockReset().mockImplementation(async (_id: number, settings: typeof mocks.settings) => {
      mocks.settings = settings
    })
    mocks.fetchRepositories.mockReset().mockResolvedValue({ status: 'ok', repositories: [repository] })
    mocks.fetchEvents.mockReset().mockResolvedValue({
      login: 'octo',
      input: {
        sourceId: '9001',
        companionId: 'octo',
        commits: [{
          id: 'sha-1',
          repositoryId: '101',
          occurredAt: '2026-09-12T12:00:00Z',
          additions: 2,
          changedFiles: 1,
        }],
      },
      status: 'ok',
      truncated: false,
    })
  })

  it('records a first-use baseline and awards no old activity', async () => {
    const response = await POST(request())
    const body = await readSyncBody(response)

    expect(response.status).toBe(200)
    expect(body.kind).toBe('baseline')
    expect(body.events).toEqual([])
    expect(body.newBaselineRepositoryIds).toEqual(['101'])
    expect(mocks.settings.baselineByRepositoryId).toEqual({})
    expect(body.checkpoint).toEqual(expect.stringMatching(/\./u))
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('records a baseline for a truncated-but-successful read so XP can start', async () => {
    // REGRESSION: a bounded scan that reached its page ceiling used to be
    // counted as a failed request. That made `status` `partial`, the baseline
    // was never written, `occurredAfterBaseline` stayed false for every
    // repository, and the account stayed at zero XP forever no matter how many
    // times the user pressed "Sync GitHub now".
    mocks.fetchEvents.mockResolvedValue({
      login: 'octo',
      status: 'ok',
      truncated: true,
      input: {
        sourceId: '9001',
        companionId: 'octo',
        commits: [{
          id: 'sha-1',
          repositoryId: '101',
          occurredAt: '2026-09-12T12:00:00Z',
          additions: 2,
          changedFiles: 1,
        }],
      },
    })

    const response = await POST(request())
    const body = await readSyncBody(response)

    expect(body.syncStatus).toBe('ok')
    expect(body.kind).toBe('baseline')
    expect(body.newBaselineRepositoryIds).toEqual(['101'])
    // The window boundary is reported honestly alongside the baseline.
    expect(body.truncated).toBe(true)
  })

  it('filters by the stored baseline and sends only normalized verified events', async () => {
    mocks.settings.baselineByRepositoryId = { '101': '2026-01-01T00:00:00.000Z' }

    const response = await POST(request())
    const body = await readSyncBody(response)

    expect(response.status).toBe(200)
    expect(body.kind).toBe('synced')
    const events = body.events as Array<{ category: string; provenance: string }>
    expect(events.map((event) => event.category)).toEqual([
      'qualifying-active-day',
      'work-session',
    ])
    expect(events.every((event) => event.provenance === 'verified')).toBe(true)
    expect(Object.values(body.verifiedEventProofs as Record<string, string>)).toEqual([
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    ])
    expect(mocks.fetchEvents).toHaveBeenCalledWith(expect.objectContaining({
      login: 'octo',
      token: 'server-token',
      sourceId: '9001',
      repos: [{ fullName: 'octo/garden', id: '101' }],
    }))
  })

  it('does not create a baseline when GitHub returns a partial activity read', async () => {
    mocks.fetchEvents.mockResolvedValue({
      login: 'octo',
      status: 'partial',
      truncated: false,
      input: { sourceId: '9001', companionId: 'octo', commits: [] },
    })

    const response = await POST(request())
    const body = await readSyncBody(response)

    expect(response.status).toBe(200)
    expect(body.kind).toBe('partial')
    expect(body.newBaselineRepositoryIds).toEqual([])
    expect(mocks.settings.baselineByRepositoryId).toEqual({})
  })

  it('does not advance the baseline when receipt issuance fails', async () => {
    mocks.settings.baselineByRepositoryId = { '101': '2026-01-01T00:00:00.000Z' }
    vi.stubEnv('SESSION_SECRET', '')

    const response = await POST(request())
    // The read has already begun streaming by the time receipt issuance runs, so
    // the HTTP status is committed and the failure is reported in-band instead.
    const events = await readSyncEvents(response)
    const failure = events.find((event) => event.type === 'error')

    expect(response.status).toBe(200)
    expect(failure).toBeDefined()
    expect(failure?.status).toBe(500)
    expect(mocks.settings.baselineByRepositoryId).toEqual({ '101': '2026-01-01T00:00:00.000Z' })
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('streams repository progress before the result', async () => {
    // A long sync with no output is indistinguishable from a frozen one, which
    // is exactly how the user experienced it.
    const response = await POST(request())
    const events = await readSyncEvents(response)

    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson')
    expect(events[0]).toMatchObject({ type: 'start', repositoryCount: 1 })
    expect(events[events.length - 1]?.type).toBe('result')
  })

  it('tells the user to retry instead of reconnecting when GitHub rate limits us', async () => {
    mocks.fetchRepositories.mockResolvedValue({ status: 'rate-limited', repositories: [] })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(String(body.error)).toContain('rate limit')
  })

  it('honors a manual exclusion even when automatic personal inclusion is enabled', async () => {
    mocks.settings = {
      trackedRepositoryIds: [],
      excludedRepositoryIds: ['101'],
      autoIncludePersonal: true,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    }

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.repositoryCount).toBe(0)
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
  })

  it('keeps auto-included repositories policy-derived so disabling auto inclusion stops tracking', async () => {
    mocks.settings = {
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: true,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    }

    const first = await POST(request())
    expect(first.status).toBe(200)
    expect((await readSyncBody(first)).newBaselineRepositoryIds).toEqual(['101'])
    expect(mocks.settings.trackedRepositoryIds).toEqual([])

    mocks.settings.autoIncludePersonal = false
    const second = await POST(request())
    expect(second.status).toBe(200)
    expect((await second.json()).repositoryCount).toBe(0)
  })

  it('clears a baseline when a complete repository refresh no longer exposes it', async () => {
    mocks.settings.baselineByRepositoryId = { '101': '2026-01-01T00:00:00.000Z' }
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', repositories: [] })

    const response = await POST(request())
    const body = await response.json()
    const checkpoint = verifyGithubSyncCheckpoint(body.checkpoint, 9001)

    expect(response.status).toBe(200)
    expect(checkpoint?.nextBaselineByRepositoryId).toEqual({})
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
  })
})
