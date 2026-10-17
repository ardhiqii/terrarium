import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { MAX_CHECKPOINT_BASELINE_ENTRIES, MAX_CHECKPOINT_EVENT_IDS, verifyGithubSyncCheckpoint } from '@/lib/sync/github-sync-checkpoint'
import { verifyGithubSyncContinuation } from '@/lib/sync/github-sync-continuation'
import { MAX_SYNC_REPOSITORIES } from '@/lib/sync/sync-schedule'
import { normalizeGitHubEvents } from '@/lib/game/github-events'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createEncounterState } from '@/lib/game/encounters'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { createProductState } from '@/lib/game/product-state'
import { buildProductSnapshot } from '@/lib/sync/product-snapshot'
import { getProductStore, resetProductStoreForTests } from '@/lib/sync/product-store'
import { issueVerifiedEventProof } from '@/lib/sync/verified-event-proof'
import { cacheClearAll } from '@/lib/game/api-cache'
import {
  clearGithubRepositoryCache,
  getGithubRepositoriesCached,
} from '@/lib/sync/github-repository-cache'

const mocks = vi.hoisted(() => ({
  fetchRepositoriesById: vi.fn(),
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
  fetchGithubRepositoriesById: mocks.fetchRepositoriesById,
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

function request(extraHeaders: HeadersInit = {}, activeCompanionId = 'pikachu-family', continuation?: string): NextRequest {
  return new NextRequest('http://localhost/api/github/sync', {
    method: 'POST',
    body: JSON.stringify({ activeCompanionId, ...(continuation ? { continuation } : {}) }),
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
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
  // A sync that only registers first-use baselines reads nothing, so it has no
  // stream to maintain and answers with an ordinary JSON body.
  if (events.length === 1 && events[0]?.type === undefined) return events[0]
  const result = events.find((event) => event.type === 'result')
  if (!result) {
    const failure = events.find((event) => event.type === 'error')
    throw new Error(`Sync failed: ${String(failure?.error ?? 'no result payload')}`)
  }
  return result.payload as Record<string, unknown>
}

async function seedTrustedGithubProductSnapshot(): Promise<void> {
  const now = '2026-09-12T12:00:00.000Z'
  const sourceEvents = normalizeGitHubEvents({
    sourceId: '9001',
    companionId: 'pikachu-family',
    commits: [{
      id: 'sha-1',
      repositoryId: '101',
      occurredAt: now,
      additions: 2,
      changedFiles: 1,
    }],
  })
  const profile = createGuestProfile({
    guestId: 'guest-1',
    starterCompanionId: 'pikachu-family',
    now,
  })
  const unsigned = buildProductSnapshot(
    createProductState(
      profile,
      { events: sourceEvents },
      createEncounterState(),
      PROTOTYPE_COMPANION_CATALOG,
    ),
    now,
  )
  const snapshot = {
    ...unsigned,
    events: unsigned.events.map((event) => ({
      ...event,
      provenance: 'verified' as const,
      verifiedProof: issueVerifiedEventProof(event, 9001),
    })),
  }
  expect(await getProductStore().put(9001, 'octo', snapshot, now, null)).toBe(true)
}

describe('POST /api/github/sync', () => {
  beforeEach(() => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    vi.stubEnv('SYNC_STORE', 'sqlite')
    resetProductStoreForTests(':memory:')
    // The per-account sync rate limiter is module-global; reset it so this
    // file's assertion count does not depend on how many syncs it issues.
    cacheClearAll()
    clearGithubRepositoryCache()
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
    mocks.fetchRepositories.mockReset().mockResolvedValue({ status: 'ok', truncated: false, repositories: [repository] })
    mocks.fetchRepositoriesById.mockReset().mockResolvedValue({ status: 'ok', repositories: [] })
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

  it('rejects a malformed or mismatched account header before sync work', async () => {
    const malformed = await POST(request({ 'x-terrarium-github-id': '9001.0' }))
    expect(malformed.status).toBe(409)
    expect(await malformed.json()).toEqual({ error: 'account_changed' })

    const mismatched = await POST(new NextRequest('http://localhost/api/github/sync', {
      method: 'POST',
      body: '{bad json',
      headers: {
        'Content-Type': 'application/json',
        'x-terrarium-github-id': '9002',
      },
    }))
    expect(mismatched.status).toBe(409)
    expect(await mismatched.json()).toEqual({ error: 'account_changed' })
    expect(mocks.getToken).not.toHaveBeenCalled()
    expect(mocks.getSettings).not.toHaveBeenCalled()
    expect(mocks.fetchRepositories).not.toHaveBeenCalled()
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
  })

  it('accepts a matching account header as well as older requests without one', async () => {
    const response = await POST(request({ 'x-terrarium-github-id': '9001' }))
    expect(response.status).toBe(200)
    await readSyncEvents(response)

    const legacy = await POST(request())
    expect(legacy.status).toBe(200)
  })

  it('rejects an unrecognized active companion before minting receipts', async () => {
    const response = await POST(new NextRequest('http://localhost/api/github/sync', {
      method: 'POST',
      body: JSON.stringify({ activeCompanionId: 'not-in-catalog' }),
      headers: { 'Content-Type': 'application/json' },
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/recognized companion/i) })
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

  it('rejects a truncated catch-up without advancing a baseline or checkpoint', async () => {
    mocks.settings.baselineByRepositoryId = { '101': '2026-09-01T00:00:00.000Z' }
    // A bounded window cannot prove that it reached the stored checkpoint. It
    // must fail closed rather than silently aging skipped activity out of the
    // account forever.
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
    const events = await readSyncEvents(response)
    const failure = events.find((event) => event.type === 'error')
    expect(response.status).toBe(200)
    expect(failure).toMatchObject({
      status: 409,
      error: expect.stringMatching(/incomplete/i),
    })
    expect(events.some((event) => event.type === 'result')).toBe(false)
    expect(mocks.settings.baselineByRepositoryId).toEqual({ '101': '2026-09-01T00:00:00.000Z' })
  })

  it('returns a signed continuation without advancing the baseline, then resumes it', async () => {
    mocks.settings.baselineByRepositoryId = { '101': '2026-09-01T00:00:00.000Z' }
    mocks.fetchEvents.mockResolvedValueOnce({
      login: 'octo',
      status: 'ok',
      truncated: true,
      continuation: { '101': { page: 4 } },
      input: {
        sourceId: '9001',
        companionId: 'octo',
        commits: [{
          id: 'sha-partial',
          repositoryId: '101',
          occurredAt: '2026-09-12T12:00:00Z',
          additions: 2,
          changedFiles: 1,
        }],
      },
    })

    const first = await readSyncBody(await POST(request()))
    expect(first.kind).toBe('partial')
    expect(first.checkpoint).toBeNull()
    expect(typeof first.continuation).toBe('string')
    const token = verifyGithubSyncContinuation(first.continuation as string, 9001)
    expect(token?.cursors).toEqual({ '101': { page: 4 } })
    expect(mocks.settings.baselineByRepositoryId).toEqual({ '101': '2026-09-01T00:00:00.000Z' })

    mocks.fetchEvents.mockResolvedValueOnce({
      login: 'octo',
      status: 'ok',
      truncated: false,
      input: {
        sourceId: '9001',
        companionId: 'octo',
        commits: [{
          id: 'sha-final',
          repositoryId: '101',
          occurredAt: '2026-09-12T12:01:00Z',
          additions: 2,
          changedFiles: 1,
        }],
      },
    })
    const second = await readSyncBody(await POST(request({}, 'pikachu-family', first.continuation as string)))
    expect(second.kind).toBe('synced')
    expect(second.checkpoint).toEqual(expect.stringMatching(/\./u))
    expect(mocks.fetchEvents.mock.calls[1]?.[0].continuation).toEqual({ '101': { page: 4 } })
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

  it('blocks a mixed replay and new-event batch for an unowned active companion before minting receipts', async () => {
    mocks.settings.baselineByRepositoryId = { '101': '2026-01-01T00:00:00.000Z' }
    await seedTrustedGithubProductSnapshot()
    mocks.fetchEvents.mockResolvedValueOnce({
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
        mergedPullRequests: [{
          id: 'new-pr',
          repositoryId: '101',
          number: 7,
          mergedAt: '2026-09-12T13:00:00Z',
        }],
      },
      status: 'ok',
      truncated: false,
    })

    const response = await POST(request({}, 'ditto-like'))
    const events = await readSyncEvents(response)
    const failure = events.find((event) => event.type === 'error')

    expect(response.status).toBe(200)
    expect(failure).toMatchObject({
      status: 400,
      error: expect.stringMatching(/owned by the product account/i),
    })
    expect(events.some((event) => event.type === 'result')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('verifiedEventProofs')
    expect(JSON.stringify(events)).not.toContain('checkpoint')
    expect(mocks.saveSettings).not.toHaveBeenCalled()
    expect(mocks.settings.baselineByRepositoryId).toEqual({ '101': '2026-01-01T00:00:00.000Z' })
  })

  it('does not create a baseline when GitHub returns a partial activity read', async () => {
    mocks.settings.baselineByRepositoryId = { '101': '2026-09-01T00:00:00.000Z' }
    mocks.fetchEvents.mockResolvedValue({
      login: 'octo',
      status: 'partial',
      truncated: false,
      input: { sourceId: '9001', companionId: 'octo', commits: [] },
    })

    const response = await POST(request())
    const events = await readSyncEvents(response)
    const failure = events.find((event) => event.type === 'error')

    expect(response.status).toBe(200)
    expect(failure).toMatchObject({
      status: 409,
      error: expect.stringMatching(/incomplete/i),
    })
    expect(events.some((event) => event.type === 'result')).toBe(false)
    expect(mocks.settings.baselineByRepositoryId).toEqual({ '101': '2026-09-01T00:00:00.000Z' })
  })

  it('resumes a read whose pages failed instead of ending the whole sync', async () => {
    // A page that could not be read is truncation, not completion: the fetcher
    // keeps its cursor on the page that failed, so the retry resumes there
    // instead of failing the whole sync and re-reading everything from scratch.
    mocks.settings.baselineByRepositoryId = { '101': '2026-09-01T00:00:00.000Z' }
    mocks.fetchEvents.mockResolvedValue({
      login: 'octo',
      status: 'partial',
      truncated: true,
      continuation: { '101': { page: 2 } },
      input: { sourceId: '9001', companionId: 'octo', commits: [] },
    })

    const body = await readSyncBody(await POST(request()))

    expect(body.kind).toBe('partial')
    expect(body.checkpoint).toBeNull()
    const token = verifyGithubSyncContinuation(body.continuation as string, 9001)
    expect(token?.cursors).toEqual({ '101': { page: 2 } })
    expect(mocks.settings.baselineByRepositoryId).toEqual({ '101': '2026-09-01T00:00:00.000Z' })
  })

  it('reports no baseline registrations on a partial result because nothing was committed', async () => {
    // Red-team: the baseline map only reaches the account through the
    // checkpoint that follows a complete read. A partial result carries
    // `checkpoint: null` and saves no settings, so the registration made in
    // memory at the top of the read is not real. Reporting it let the panel
    // claim "N repositories registered" about a write that never happened; the
    // resume registers the same repositories again, and only that sync's
    // checkpoint makes them real.
    const known = { ...repository, id: '101', fullName: 'octo/garden' }
    const fresh = { ...repository, id: '202', name: 'new-garden', fullName: 'octo/new-garden' }
    mocks.settings = {
      trackedRepositoryIds: ['101', '202'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: { '101': '2026-09-01T00:00:00.000Z' },
      lastSyncedAt: null,
    }
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [known, fresh] })
    mocks.fetchEvents.mockResolvedValue({
      login: 'octo',
      status: 'partial',
      truncated: true,
      continuation: { '101': { page: 2 } },
      input: { sourceId: '9001', companionId: 'octo', commits: [] },
    })

    const body = await readSyncBody(await POST(request()))

    expect(body.kind).toBe('partial')
    expect(body.checkpoint).toBeNull()
    expect(typeof body.continuation).toBe('string')
    // The read window held only the baselined repository, and the fresh one
    // was registered in memory only: nothing may be reported as committed.
    expect(body.repositoryCount).toBe(1)
    expect(mocks.settings.baselineByRepositoryId).toEqual({ '101': '2026-09-01T00:00:00.000Z' })
    expect(body.newBaselineRepositoryIds).toEqual([])
  })

  it.fails('commits the registration time of the attempt that first saw a new repository', async () => {
    // Red-team: a partial attempt registers a first-use repository in memory at
    // T1 but commits nothing. The resume registers it again at T2 and commits
    // T2 as its baseline, so activity in that repository between T1 and T2 is
    // never read by any sync and can never award XP. The continuation carries
    // cursors, not the first-registration timestamps, so the hole survives a
    // reload. Desired behavior: the committed baseline is the moment the
    // account first saw the repository, not the moment a retry happened to
    // succeed.
    vi.useFakeTimers()
    try {
      const T1 = '2026-10-01T00:00:00.000Z'
      const T2 = '2026-10-01T12:00:00.000Z'
      const known = { ...repository, id: '101', fullName: 'octo/garden' }
      const fresh = { ...repository, id: '202', name: 'new-garden', fullName: 'octo/new-garden' }
      mocks.settings = {
        trackedRepositoryIds: ['101', '202'],
        excludedRepositoryIds: [],
        autoIncludePersonal: false,
        autoIncludeOrganizations: [],
        baselineByRepositoryId: { '101': '2026-09-01T00:00:00.000Z' },
        lastSyncedAt: null,
      }
      mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [known, fresh] })
      mocks.fetchEvents.mockResolvedValueOnce({
        login: 'octo',
        status: 'partial',
        truncated: true,
        continuation: { '101': { page: 2 } },
        input: { sourceId: '9001', companionId: 'octo', commits: [] },
      })
      vi.setSystemTime(new Date(T1))
      const first = await readSyncBody(await POST(request()))

      vi.setSystemTime(new Date(T2))
      mocks.fetchEvents.mockResolvedValueOnce({
        login: 'octo',
        status: 'ok',
        truncated: false,
        input: { sourceId: '9001', companionId: 'octo', commits: [] },
      })
      const second = await readSyncBody(await POST(request({}, 'pikachu-family', first.continuation as string)))
      const checkpoint = verifyGithubSyncCheckpoint(second.checkpoint as string, 9001)

      expect(checkpoint?.nextBaselineByRepositoryId['202']).toBe(T1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.fails('registers a repository beyond the checkpoint baseline capacity on a later sync', async () => {
    // Red-team: the checkpoint's baseline map is capped at
    // MAX_CHECKPOINT_BASELINE_ENTRIES, and the sync budget is the remaining
    // capacity. Once the map holds the cap, a surplus repository can never be
    // registered, so it is never read and can never award activity -- while
    // `skippedRepositoryCount` makes the panel promise "will be covered by
    // later syncs". Desired behavior: the surplus is eventually registered, or
    // the response/UI says plainly that it cannot be covered.
    const many = Array.from({ length: MAX_CHECKPOINT_BASELINE_ENTRIES + 1 }, (_, index) => ({
      ...repository,
      id: String(5000 + index),
      name: `cap-${index}`,
      fullName: `octo/cap-${index}`,
    }))
    const surplusId = many[many.length - 1]!.id
    mocks.settings = {
      trackedRepositoryIds: many.map((entry) => entry.id),
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: Object.fromEntries(
        many.slice(0, MAX_CHECKPOINT_BASELINE_ENTRIES).map((entry) => [entry.id, '2026-01-01T00:00:00.000Z']),
      ),
      lastSyncedAt: null,
    }
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: many })
    mocks.fetchEvents.mockResolvedValue({
      login: 'octo',
      status: 'ok',
      truncated: false,
      input: { sourceId: '9001', companionId: 'octo' },
    })

    const seen = new Set<string>()
    for (let round = 0; round < 2; round += 1) {
      const body = await readSyncBody(await POST(request()))
      for (const id of body.newBaselineRepositoryIds as string[]) seen.add(id)
      const checkpoint = verifyGithubSyncCheckpoint(body.checkpoint as string, 9001)
      mocks.settings.baselineByRepositoryId = { ...(checkpoint?.nextBaselineByRepositoryId ?? {}) }
    }

    expect(seen.has(surplusId)).toBe(true)
  })

  it.fails('resumes a four-repository read whose deferred check backlog overflows the continuation budget', async () => {
    // Red-team: a repository with more merged pull requests than
    // MAX_CHECK_RUN_COMMITS (15) carries the remainder in `pendingCheckShas`
    // across resume rounds. Four repositories with a full pull-request history
    // (2 SHAs per PR, 165 deferred each) encode a continuation far past
    // MAX_CONTINUATION_TOKEN_LENGTH (12 KiB, chosen to fit the 16 KiB sync
    // body; measured: 1 repository fits at 10.7 KiB, 4 throw).
    // `issueGithubSyncContinuation` throws inside `buildBody(true)`, the stream
    // answers `{ type: 'error', status: 500 }`, and no progress is possible:
    // every retry re-reads the same backlog and dies in the same place, because
    // the failing page-ceiling retry path is the only advertised recovery.
    // Desired behavior: a resume that fits the transport budget, e.g. by
    // trimming the least valuable cursors and re-reading those repositories.
    const repos = Array.from({ length: MAX_SYNC_REPOSITORIES }, (_, index) => ({
      ...repository,
      id: String(6100 + index),
      name: `busy-${index}`,
      fullName: `octo/busy-${index}`,
    }))
    mocks.settings = {
      trackedRepositoryIds: repos.map((entry) => entry.id),
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: Object.fromEntries(repos.map((entry) => [entry.id, '2026-01-01T00:00:00.000Z'])),
      lastSyncedAt: null,
    }
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: repos })
    const cursors = Object.fromEntries(repos.map((entry, repoIndex) => [entry.id, {
      pullRequestsPage: 4,
      pendingCheckShas: Array.from({ length: 165 }, (_, shaIndex) => (
        String(repoIndex * 1000 + shaIndex).padStart(40, '0')
      )),
    }]))
    mocks.fetchEvents.mockResolvedValue({
      login: 'octo',
      status: 'partial',
      truncated: true,
      continuation: cursors,
      input: { sourceId: '9001', companionId: 'octo' },
    })

    const body = await readSyncBody(await POST(request()))

    expect(body.kind).toBe('partial')
    expect(typeof body.continuation).toBe('string')
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
    // is exactly how the user experienced it. A stream exists for a read
    // window: repositories waiting for their first baseline are registered
    // without a read and answer directly.
    mocks.settings.baselineByRepositoryId = { '101': '2026-01-01T00:00:00.000Z' }
    const response = await POST(request())
    const events = await readSyncEvents(response)

    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(events[0]).toMatchObject({ type: 'start', repositoryCount: 1 })
    expect(events[events.length - 1]?.type).toBe('result')
  })

  it('tells the user to retry instead of reconnecting when GitHub rate limits us', async () => {
    mocks.fetchRepositories.mockResolvedValue({ status: 'rate-limited', truncated: false, repositories: [] })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
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

  it('registers every repository without a baseline in one sync instead of stranding any', async () => {
    // REGRESSION: a hard ceiling of 25 repositories stranded 19 of a
    // 44-repository account -- those repositories could never be baselined, so
    // none of their activity could ever award XP. The derived window then
    // walked them four per sync, which still meant eleven silent syncs before a
    // single read could award anything. A first-use baseline costs no GitHub
    // read, so one checkpoint registers the whole account now.
    const many = Array.from({ length: 44 }, (_, index) => ({
      ...repository,
      id: String(2000 + index),
      name: `repo-${index}`,
      fullName: `octo/repo-${index}`,
    }))
    mocks.settings = {
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: true,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    }
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: many })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.kind).toBe('baseline')
    expect((body.newBaselineRepositoryIds as string[]).length).toBe(many.length)
    expect(body.repositoryCount).toBe(0)
    expect(body.skippedRepositoryCount).toBe(0)
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
    const checkpoint = verifyGithubSyncCheckpoint(body.checkpoint as string, 9001)
    expect(checkpoint).not.toBeNull()
    expect(Object.keys(checkpoint?.nextBaselineByRepositoryId ?? {})).toHaveLength(many.length)
  })

  it('rotates completed baseline windows instead of retrying the same repositories', async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...repository,
      id: String(3100 + index),
      name: `rotating-${index}`,
      fullName: `octo/rotating-${index}`,
    }))
    mocks.settings = {
      trackedRepositoryIds: many.map((entry) => entry.id),
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: Object.fromEntries(many.map((entry) => [entry.id, '2026-01-01T00:00:00.000Z'])),
      lastSyncedAt: null,
    }
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: many })

    const first = await readSyncBody(await POST(request()))
    expect(mocks.fetchEvents.mock.calls[0]?.[0].repos.map((entry: { id: string }) => entry.id))
      .toEqual(['3100', '3101', '3102', '3103'])
    const firstCheckpoint = verifyGithubSyncCheckpoint(first.checkpoint as string, 9001)
    expect(firstCheckpoint).not.toBeNull()
    mocks.settings.baselineByRepositoryId = firstCheckpoint!.nextBaselineByRepositoryId

    await readSyncBody(await POST(request()))
    expect(mocks.fetchEvents.mock.calls[1]?.[0].repos.map((entry: { id: string }) => entry.id))
      .toEqual(['3104', '3105', '3106', '3107'])
  })

  it('never builds a checkpoint its own validator rejects, however heavy the activity', async () => {
    // REGRESSION: the read window used to come from the hourly request budget
    // alone (222 repositories) while the checkpoint accepted 5,000 event IDs.
    // A heavy repository produces up to 1,080 events, so a wide window could
    // build a checkpoint that `issueGithubSyncCheckpoint` itself rejected: the
    // throw happened inside the response stream and the route wrote
    // { type: 'error', status: 500 } at HTTP 200 -- nothing awarded, no
    // baseline, and every retry re-read the same activity forever. The window
    // is now bounded by the checkpoint's capacity, so a full window always
    // fits.
    const heavy = Array.from({ length: 44 }, (_, index) => ({
      ...repository,
      id: String(4000 + index),
      name: `heavy-${index}`,
      fullName: `octo/heavy-${index}`,
    }))
    mocks.settings = {
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: true,
      autoIncludeOrganizations: [],
      // Every repository is already baselined, so the fetched activity is not
      // withheld from normalization: this is a catch-up sync, the heaviest
      // case for the checkpoint.
      baselineByRepositoryId: Object.fromEntries(
        heavy.map((entry) => [entry.id, '2026-01-01T00:00:00.000Z']),
      ),
      lastSyncedAt: null,
    }
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: heavy })
    // The real fetcher only returns activity for the repositories it was asked
    // to read; the mock honours the request so the window is actually exercised.
    mocks.fetchEvents.mockImplementation(async (options: { repos: Array<{ id: string }> }) => {
      const requested = new Set(options.repos.map((ref) => ref.id))
      const mergedPullRequests: Array<Record<string, unknown>> = []
      const releases: Array<Record<string, unknown>> = []
      for (const entry of heavy.filter((repo) => requested.has(repo.id))) {
        // The fetcher's own ceilings: 3 x 30 merged pull requests and 30 releases.
        for (let number = 0; number < 90; number += 1) {
          mergedPullRequests.push({
            id: `${entry.id}-pr-${number}`,
            repositoryId: entry.id,
            number,
            mergedAt: '2026-09-12T10:00:00Z',
          })
        }
        for (let number = 0; number < 30; number += 1) {
          releases.push({
            id: `${entry.id}-release-${number}`,
            repositoryId: entry.id,
            tagName: `v${number}`,
            publishedAt: '2026-09-12T11:00:00Z',
            draft: false,
            published: true,
          })
        }
      }
      return {
        login: 'octo',
        input: { sourceId: '9001', companionId: 'octo', mergedPullRequests, releases },
        status: 'ok',
        truncated: false,
      }
    })

    const events = await readSyncEvents(await POST(request()))

    expect(events.some((event) => event.type === 'error')).toBe(false)
    const body = events.find((event) => event.type === 'result')?.payload as Record<string, unknown>
    const checkpoint = verifyGithubSyncCheckpoint(body.checkpoint as string, 9001)
    expect(checkpoint).not.toBeNull()
    // The unwindowed account would emit 44 x 120 = 5,280 events, past the old
    // 5,000 boundary; the derived window keeps what a sync emits inside the
    // checkpoint's capacity (120 repository-scoped events per windowed
    // repository, plus the one account-wide qualifying-active-day event).
    expect(44 * 120).toBeGreaterThan(MAX_CHECKPOINT_EVENT_IDS)
    expect(checkpoint?.eventIds.length).toBeGreaterThanOrEqual(MAX_SYNC_REPOSITORIES * 120)
    expect(checkpoint?.eventIds.length).toBeLessThanOrEqual(MAX_CHECKPOINT_EVENT_IDS)
  })

  it('keeps a repository waiting for its baseline out of the read window without stranding it', async () => {
    // A repository without a baseline can never award anything, and it used to
    // occupy one of the four read slots until its baseline was committed. It is
    // now registered in the same sync, while the read window only ever holds
    // repositories that can award.
    const known = { ...repository, id: '101', name: 'garden', fullName: 'octo/garden' }
    const fresh = { ...repository, id: '202', name: 'new-garden', fullName: 'octo/new-garden' }
    mocks.settings = {
      trackedRepositoryIds: ['101', '202'],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: { '101': '2026-01-01T00:00:00.000Z' },
      lastSyncedAt: null,
    }
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [known, fresh] })

    const events = await readSyncEvents(await POST(request()))
    const body = events.find((event) => event.type === 'result')?.payload as Record<string, unknown>

    expect(events[0]).toMatchObject({
      type: 'start',
      repositoryCount: 1,
      repositoryNames: ['octo/garden'],
    })
    expect(mocks.fetchEvents.mock.calls[0]?.[0].repos.map((entry: { id: string }) => entry.id))
      .toEqual(['101'])
    expect(body.newBaselineRepositoryIds).toEqual(['202'])
    const checkpoint = verifyGithubSyncCheckpoint(body.checkpoint as string, 9001)
    expect(checkpoint?.nextBaselineByRepositoryId).toEqual({
      '101': expect.any(String),
      '202': expect.any(String),
    })
  })

  it('clears a baseline when a complete repository refresh no longer exposes it', async () => {
    mocks.settings.baselineByRepositoryId = { '101': '2026-01-01T00:00:00.000Z' }
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [] })

    const response = await POST(request())
    const body = await response.json()
    const checkpoint = verifyGithubSyncCheckpoint(body.checkpoint, 9001)

    expect(response.status).toBe(200)
    expect(checkpoint?.nextBaselineByRepositoryId).toEqual({})
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
  })

  it('rejects an oversized body even when the client sends no content-length', async () => {
    const payload = JSON.stringify({
      activeCompanionId: 'pikachu-family',
      padding: 'x'.repeat(20_000),
    })
    expect(payload.length).toBeGreaterThan(16 * 1024)

    const response = await POST(new NextRequest('http://localhost/api/github/sync', {
      method: 'POST',
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

  it('reuses the cached repository listing for back-to-back syncs', async () => {
    // REGRESSION: the picker page load already listed the repositories, so a
    // sync issued right after it must not spend another five paged GitHub
    // requests re-reading the same list.
    const first = await POST(request())
    expect(first.status).toBe(200)
    await readSyncBody(first)

    const second = await POST(request())
    expect(second.status).toBe(200)
    await readSyncBody(second)

    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(1)
  })

  it('skips the baseline prune when the listing was served stale', async () => {
    // A stale listing is one GitHub could not be re-read. Pruning from it
    // would treat every temporarily unreadable repository as deleted, drop its
    // baseline, and re-baseline its activity as new work on reconnect.
    mocks.settings.baselineByRepositoryId = { '101': '2026-01-01T00:00:00.000Z' }
    // The cached listing is empty, so a naive prune would delete the baseline
    // for '101' entirely.
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [] })
    await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'server-token',
      // Seed an entry past the fresh window (and inside retention) so the next
      // sync revalidates it and then falls back to it.
      now: Date.now() - 10 * 60 * 1000,
    })
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(1)
    mocks.fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })

    const response = await POST(request())
    const body = await response.json()
    const checkpoint = verifyGithubSyncCheckpoint(body.checkpoint, 9001)

    expect(response.status).toBe(200)
    expect(checkpoint).not.toBeNull()
    expect(checkpoint?.nextBaselineByRepositoryId).toEqual({ '101': '2026-01-01T00:00:00.000Z' })
    expect(mocks.fetchEvents).not.toHaveBeenCalled()
  })

  it('skips the baseline prune when the listing was truncated at the page ceiling', async () => {
    // A 501+-repository account gets a 500-repository "ok" listing that fills
    // the fifth page. Treating it as complete would delete the baseline of
    // every tracked repository past page 5 and re-baseline its activity.
    mocks.settings.trackedRepositoryIds = ['101', '501']
    mocks.settings.baselineByRepositoryId = {
      '101': '2026-01-01T00:00:00.000Z',
      '501': '2026-01-01T00:00:00.000Z',
    }
    mocks.fetchRepositories.mockResolvedValue({
      status: 'ok',
      repositories: [repository],
      truncated: true,
    })

    const response = await POST(request())
    const body = await readSyncBody(response)
    const checkpoint = verifyGithubSyncCheckpoint(body.checkpoint as string, 9001)

    expect(response.status).toBe(200)
    expect(checkpoint?.nextBaselineByRepositoryId).toEqual({
      '101': expect.any(String),
      '501': '2026-01-01T00:00:00.000Z',
    })
  })

  it('purges the cached listing and asks for a reconnect when GitHub revokes access', async () => {
    await getGithubRepositoriesCached({
      githubId: 9001,
      token: 'server-token',
      // Past the fresh window, so the sync actually revalidates.
      now: Date.now() - 10 * 60 * 1000,
    })
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(1)

    mocks.fetchRepositories.mockResolvedValue({ status: 'unauthorized', truncated: false, repositories: [] })
    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(String((await response.json()).error)).toContain('Reconnect')

    // The revoked listing is gone, so a later failure has nothing to fall back to.
    mocks.fetchRepositories.mockResolvedValue({ status: 'unavailable', truncated: false, repositories: [] })
    const after = await POST(request())
    expect(after.status).toBe(502)
  })
})
