import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { normalizeGitHubEvents } from '@/lib/game/github-events'
import { productSnapshotEvent } from '@/lib/sync/product-snapshot'
import { issueVerifiedEventProof, verifyVerifiedEventProof } from '@/lib/sync/verified-event-proof'
import { MAX_SYNC_REPOSITORIES } from '@/lib/sync/sync-schedule'
import { clearGithubRepositoryCache } from '@/lib/sync/github-repository-cache'
import { issueGithubSyncCheckpoint } from '@/lib/sync/github-sync-checkpoint'
import { cacheClearAll } from '@/lib/game/api-cache'

const mocks = vi.hoisted(() => ({
  settings: {
    trackedRepositoryIds: ['101'],
    excludedRepositoryIds: [] as string[],
    autoIncludePersonal: false,
    autoIncludeOrganizations: [] as string[],
    baselineByRepositoryId: { '101': '2026-01-01T00:00:00.000Z' } as Record<string, string>,
    lastSyncedAt: '2026-01-01T00:00:00.000Z' as string | null,
  },
  getToken: vi.fn(),
  getSettings: vi.fn(),
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
  }),
}))

vi.mock('@/lib/sync/github-repositories', () => ({
  fetchGithubRepositories: mocks.fetchRepositories,
}))

vi.mock('@/lib/game/github-events-fetch', () => ({
  fetchGitHubEvents: mocks.fetchEvents,
}))

vi.mock('@/lib/sync/product-store', () => ({
  getProductStore: () => ({ getRecord: vi.fn().mockResolvedValue(null) }),
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

function request(body: unknown, extraHeaders: HeadersInit = {}): NextRequest {
  return new NextRequest('http://localhost/api/github/repair', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

function checkpointFor(eventIds: readonly string[]): string {
  return issueGithubSyncCheckpoint({
    githubId: 9001,
    previousBaselineByRepositoryId: mocks.settings.baselineByRepositoryId,
    nextBaselineByRepositoryId: mocks.settings.baselineByRepositoryId,
    nextLastSyncedAt: mocks.settings.lastSyncedAt,
    eventIds,
  })
}

function repairBody(eventIds: readonly string[]): Record<string, unknown> {
  return {
    activeCompanionId: 'pikachu-family',
    eventIds,
    checkpoint: checkpointFor(eventIds),
    proofs: {},
  }
}

function candidateEvent(): ReturnType<typeof productSnapshotEvent> {
  const normalized = normalizeGitHubEvents({
    sourceId: '9001',
    companionId: 'pikachu-family',
    commits: [{
      id: 'sha-1',
      repositoryId: '101',
      occurredAt: '2026-09-12T12:00:00Z',
      additions: 2,
      changedFiles: 1,
    }],
  })
  const event = normalized.find((item) => item.category === 'work-session')
  if (!event) throw new Error('fixture did not produce a work-session event')
  return productSnapshotEvent(event)
}

function candidateEventId(): string {
  return candidateEvent().eventId
}

describe('POST /api/github/repair', () => {
  beforeEach(() => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    cacheClearAll()
    clearGithubRepositoryCache()
    mocks.settings = {
      trackedRepositoryIds: ['101'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: { '101': '2026-01-01T00:00:00.000Z' },
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
    }
    mocks.getToken.mockReset().mockResolvedValue('server-token')
    mocks.getSettings.mockReset().mockImplementation(async () => mocks.settings)
    mocks.fetchRepositories.mockReset().mockResolvedValue({ status: 'ok', truncated: false, repositories: [repository] })
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

  it('rejects a malformed or mismatched account header before repair work', async () => {
    const malformed = await POST(request(repairBody(['event-12345678-abcdef12']), {
      'x-terrarium-github-id': '9001x',
    }))
    expect(malformed.status).toBe(409)
    expect(await malformed.json()).toEqual({ error: 'account_changed' })

    const mismatched = await POST(request(repairBody(['event-12345678-abcdef12']), {
      'x-terrarium-github-id': '9002',
    }))
    expect(mismatched.status).toBe(409)
    expect(await mismatched.json()).toEqual({ error: 'account_changed' })
    expect(mocks.getToken).not.toHaveBeenCalled()
    expect(mocks.getSettings).not.toHaveBeenCalled()
    expect(mocks.fetchRepositories).not.toHaveBeenCalled()
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
  })

  it('accepts a matching account header and older requests without one', async () => {
    const event = candidateEvent()
    const body = {
      ...repairBody([event.eventId]),
      proofs: { [event.eventId]: issueVerifiedEventProof(event, 9001) },
    }
    const response = await POST(request(body, {
      'x-terrarium-github-id': '9001',
    }))
    expect(response.status).toBe(200)
    expect((await response.json()).repaired).toHaveLength(1)

    const legacy = await POST(request(body))
    expect(legacy.status).toBe(200)
  })

  it('does not bind an ownerless checkpoint event to the active companion', async () => {
    const response = await POST(request(repairBody([candidateEventId()])))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.repaired).toEqual([])
    expect(body.blocked[0]).toMatchObject({ reason: 'event-owner-unavailable' })
  })

  it('re-reads server-approved activity and issues a fresh receipt without mutating the checkpoint', async () => {
    const event = candidateEvent()
    const response = await POST(request({
      ...repairBody([event.eventId]),
      proofs: { [event.eventId]: issueVerifiedEventProof(event, 9001) },
    }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.repaired).toHaveLength(1)
    expect(body.blocked).toEqual([])
    expect(body.repaired[0]).toMatchObject({ eventId: event.eventId, proof: expect.any(String) })
    expect(verifyVerifiedEventProof(body.repaired[0].event, 9001, body.repaired[0].proof)).toBe(true)
    expect(mocks.fetchEvents).toHaveBeenCalledWith(expect.objectContaining({
      token: 'server-token',
      sourceId: '9001',
      repos: [{ id: '101', fullName: 'octo/garden' }],
    }))
  })

  it('accepts a preserved server receipt when the checkpoint has expired', async () => {
    const event = candidateEvent()
    const response = await POST(request({
      activeCompanionId: 'pikachu-family',
      eventIds: [event.eventId],
      checkpoint: null,
      proofs: { [event.eventId]: issueVerifiedEventProof(event, 9001) },
    }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.repaired).toHaveLength(1)
    expect(body.blocked).toEqual([])
  })

  it('refuses invented activity and never accepts client event facts', async () => {
    const response = await POST(request({
      ...repairBody(['event-12345678-abcdef12']),
      xp: 999999,
    }))

    expect(response.status).toBe(400)
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
  })

  it('does not repair an event that is outside the signed checkpoint', async () => {
    const response = await POST(request({
      activeCompanionId: 'pikachu-family',
      eventIds: ['event-12345678-abcdef12'],
      checkpoint: checkpointFor(['event-deadbeef-abcdef12']),
      proofs: {},
    }))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toMatch(/signed GitHub sync checkpoint/i)
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
  })

  it('does not mint for activity attributed to another GitHub account', async () => {
    mocks.fetchEvents.mockResolvedValue({
      login: 'another-account',
      input: {
        sourceId: 'other-account',
        companionId: 'pikachu-family',
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
    const response = await POST(request(repairBody([candidateEventId()])))
    const body = await response.json()

    expect(body.repaired).toEqual([])
    expect(body.blocked[0].reason).toBe('activity-not-found')
  })

  it('does not repair an event from an untracked repository', async () => {
    mocks.settings.trackedRepositoryIds = []
    const response = await POST(request(repairBody([candidateEventId()])))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.repaired).toEqual([])
    expect(body.blocked[0]).toMatchObject({ reason: 'repository-not-tracked' })
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
  })

  it('keeps repair reads inside the same bounded 16-repository window', async () => {
    const repositories = Array.from({ length: MAX_SYNC_REPOSITORIES + 4 }, (_, index) => ({
      ...repository,
      id: String(100 + index),
      name: `repo-${index}`,
      fullName: `octo/repo-${index}`,
    }))
    mocks.settings.trackedRepositoryIds = []
    mocks.settings.autoIncludePersonal = true
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories })

    const response = await POST(request(repairBody(['event-12345678-abcdef12'])))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.repositoryCount).toBe(MAX_SYNC_REPOSITORIES)
    expect(body.skippedRepositoryCount).toBe(4)
    expect(mocks.fetchEvents).toHaveBeenCalledWith(expect.objectContaining({
      repos: expect.any(Array),
    }))
    expect((mocks.fetchEvents.mock.calls[0]?.[0].repos as unknown[]).length).toBe(MAX_SYNC_REPOSITORIES)
  })

  it('reports partial reads as blocked instead of minting an unconfirmed receipt', async () => {
    mocks.fetchEvents.mockResolvedValue({
      login: 'octo',
      input: { sourceId: '9001', companionId: 'octo', commits: [] },
      status: 'partial',
      truncated: false,
    })
    const response = await POST(request(repairBody([candidateEventId()])))
    const body = await response.json()

    expect(body.repaired).toEqual([])
    expect(body.blocked[0].reason).toBe('activity-read-incomplete')
  })
})
