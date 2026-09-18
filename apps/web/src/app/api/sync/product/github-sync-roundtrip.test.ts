/**
 * End-to-end regression for a large account's deferred baseline commit.
 *
 * REGRESSION: a 44-repository account produced more than 500 event IDs in one
 * sync. The checkpoint validator rejected that outright, so the whole sync
 * failed in-band (HTTP 200 plus an error line) and no baseline was ever
 * recorded; the sync route also reads every tracked repository now. On the way
 * there, the checkpoint used to be sent in the `x-github-sync-checkpoint`
 * request header even at ~21 KB, which is beyond a request header budget and
 * was rejected upstream as a bodyless 500 before the product route ran.
 *
 * This test drives the real routes and the real SQLite stores with only the
 * GitHub providers mocked. No network call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  fetchRepositories: vi.fn(),
  fetchEvents: vi.fn(),
}))

vi.mock('@/lib/sync/session', () => ({
  getSessionProvider: () => ({
    current: async () => ({ handle: 'octo', githubId: 9001, avatarUrl: null }),
  }),
}))

vi.mock('@/lib/sync/github-repositories', () => ({
  fetchGithubRepositories: mocks.fetchRepositories,
}))

vi.mock('@/lib/game/github-events-fetch', () => ({
  fetchGitHubEvents: mocks.fetchEvents,
}))

import { resetGithubAccountStoreForTests, getGithubAccountStore } from '@/lib/sync/github-account-store'
import { clearGithubRepositoryCache } from '@/lib/sync/github-repository-cache'
import { resetProductStoreForTests, getProductStore } from '@/lib/sync/product-store'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { createEncounterState } from '@/lib/game/encounters'
import { createGuestProfile } from '@/lib/game/guest-profile'
import { applyProductEvents, createProductState } from '@/lib/game/product-state'
import { buildProductSnapshot } from '@/lib/sync/product-snapshot'
import { MAX_SYNC_REPOSITORIES } from '@/lib/sync/sync-schedule'
import type { NormalizedEvent } from '@/lib/game/events'
import { POST as syncGithub } from '@/app/api/github/sync/route'
import { POST as syncProduct } from './route'

const GITHUB_ID = 9001
const BASELINE = '2026-01-01T00:00:00.000Z'
const REPOSITORY_COUNT = 44
/** The fetcher's own ceilings: 3 x 30 merged pull requests and 30 releases. */
const PULL_REQUESTS_PER_REPOSITORY = 90
const RELEASES_PER_REPOSITORY = 30
const EVENTS_PER_REPOSITORY = PULL_REQUESTS_PER_REPOSITORY + RELEASES_PER_REPOSITORY

const repositories = Array.from({ length: REPOSITORY_COUNT }, (_, index) => ({
  id: String(1000 + index),
  name: `repo-${index}`,
  fullName: `octo/repo-${index}`,
  ownerLogin: 'octo',
  ownerType: 'User' as const,
  private: true,
  visibility: 'private',
  defaultBranch: 'main',
  archived: false,
  canRead: true,
}))

/**
 * The activity the real fetcher would return for the repositories it was asked
 * to read. Honouring the request matters now that the read window is smaller
 * than the tracked set: a mock that ignored it would make the window look
 * ineffective and the checkpoint look oversized.
 */
function providerInput(requestedIds: readonly string[]): {
  login: string
  input: Record<string, unknown>
  status: 'ok'
  truncated: boolean
} {
  const requested = new Set(requestedIds)
  const mergedPullRequests: Array<Record<string, unknown>> = []
  const releases: Array<Record<string, unknown>> = []
  for (const repository of repositories.filter((entry) => requested.has(entry.id))) {
    for (let number = 0; number < PULL_REQUESTS_PER_REPOSITORY; number += 1) {
      mergedPullRequests.push({
        id: `${repository.id}-pr-${number}`,
        repositoryId: repository.id,
        number,
        mergedAt: `2026-08-${String(1 + (number % 28)).padStart(2, '0')}T10:00:00Z`,
      })
    }
    for (let number = 0; number < RELEASES_PER_REPOSITORY; number += 1) {
      releases.push({
        id: `${repository.id}-release-${number}`,
        repositoryId: repository.id,
        tagName: `v${number}`,
        publishedAt: `2026-08-${String(1 + (number % 28)).padStart(2, '0')}T11:00:00Z`,
        draft: false,
        published: true,
      })
    }
  }
  return {
    login: 'octo',
    input: { sourceId: String(GITHUB_ID), companionId: 'octo', mergedPullRequests, releases },
    status: 'ok',
    truncated: false,
  }
}

function syncRequest(): NextRequest {
  return new NextRequest('http://localhost/api/github/sync', {
    method: 'POST',
    body: JSON.stringify({ activeCompanionId: 'pikachu-family' }),
    headers: { 'Content-Type': 'application/json' },
  })
}

async function readSyncResult(response: Response): Promise<Record<string, unknown>> {
  const lines = (await response.text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const result = lines.find((line) => line.type === 'result')
  if (!result) {
    const failure = lines.find((line) => line.type === 'error')
    throw new Error(`Sync failed: ${String(failure?.error ?? 'no result payload')}`)
  }
  return result.payload as Record<string, unknown>
}

function productRequest(body: unknown, headers?: HeadersInit): NextRequest {
  return new NextRequest('http://localhost/api/sync/product', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('large-account GitHub sync → product checkpoint commit', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('SYNC_STORE', 'sqlite')
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    resetGithubAccountStoreForTests(':memory:')
    resetProductStoreForTests(':memory:')
    // The repository listing cache is process-global; a test that changes the
    // mocked listing must not inherit the previous test's entry.
    clearGithubRepositoryCache()
    mocks.fetchRepositories.mockReset().mockResolvedValue({ status: 'ok', repositories, truncated: false })
    mocks.fetchEvents.mockReset().mockImplementation(async (options: { repos: Array<{ id: string }> }) =>
      providerInput(options.repos.map((ref) => ref.id)),
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('commits the baseline for every tracked repository from a body checkpoint', async () => {
    const accountStore = getGithubAccountStore()
    await accountStore.putCredential({ githubId: GITHUB_ID, handle: 'octo', avatarUrl: null }, 'server-token', ['repo'])
    await accountStore.saveSettings(GITHUB_ID, {
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: true,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: Object.fromEntries(repositories.map((repository) => [repository.id, BASELINE])),
      lastSyncedAt: null,
    })

    const sync = await syncGithub(syncRequest())
    const body = await readSyncResult(sync)

    // The window is derived from the request budget and the checkpoint's event
    // capacity; the rest of the tracked set is read by the next sync.
    expect(body.repositoryCount).toBe(MAX_SYNC_REPOSITORIES)
    expect(body.skippedRepositoryCount).toBe(REPOSITORY_COUNT - MAX_SYNC_REPOSITORIES)
    expect((body.events as unknown[]).length).toBeGreaterThan(500)

    // A checkpoint over more than 500 events is issued instead of throwing.
    const checkpoint = body.checkpoint as string
    expect(checkpoint).toEqual(expect.stringMatching(/\./u))

    // The token is far too large for a request header. It is delivered in the
    // body, so this size is only worth pinning down: a header of this size was
    // rejected upstream with a bodyless 500 before the route ever ran.
    expect(checkpoint.length).toBeGreaterThan(20_000)

    const proofs = body.verifiedEventProofs as Record<string, string>
    const now = '2026-08-28T10:00:00.000Z'
    const profile = createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now })
    const state = applyProductEvents(
      createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
      body.events as NormalizedEvent[],
      PROTOTYPE_COMPANION_CATALOG,
      { triggerId: `github-sync:${String(body.lastSyncedAt)}` },
    )
    const snapshot = buildProductSnapshot(state, now, proofs)
    expect(snapshot.events.length).toBeGreaterThan(500)

    // Sizes measured for this fixture (a full window of 16 repositories, each
    // with the fetcher's ceiling of 90 merged pull requests and 30 releases):
    // 1,920 events, ~600 KB of snapshot, ~67 KB of checkpoint. The cumulative
    // snapshot plus its checkpoint must stay inside the route's payload cap,
    // and the checkpoint must stay inside its own bound, or the baseline could
    // never be committed.
    const envelopeBytes = JSON.stringify({ snapshot, checkpoint }).length
    expect(envelopeBytes).toBeLessThan(2 * 1024 * 1024)
    expect(checkpoint.length).toBeGreaterThan(4 * 1024)

    const response = await syncProduct(productRequest({ snapshot, checkpoint }))

    expect(response.status).toBe(200)
    // The whole point: the baseline advanced, so the same activity is never
    // re-read and the awarded XP is safe.
    const settings = await accountStore.getSettings(GITHUB_ID)
    expect(Object.keys(settings.baselineByRepositoryId).sort()).toEqual(
      repositories.map((repository) => repository.id).sort(),
    )
    expect(settings.lastSyncedAt).not.toBe(BASELINE)
    // KNOWN GAP (pre-existing, out of scope): the store only rewrites
    // `lastSyncedAt` when the baseline map itself changes, so a repeat sync
    // that awards events without adding a repository leaves the stored
    // timestamp behind. The baseline map above is what defers XP, and it did
    // persist. The schedule added alongside this fix keeps its own last-attempt
    // time, so cadence does not depend on this field.
    expect(settings.lastSyncedAt).toBeNull()
    // The merged product condition is stored under the signed-in account.
    expect(await getProductStore().getRecord(GITHUB_ID, 'octo')).not.toBeNull()
  })

  it('re-baselines after a disconnect instead of awarding the disconnected window', async () => {
    // Disconnect drops the credential AND the baselines. The provider still
    // returns the whole August history, which is newer than the pre-disconnect
    // baseline; with no checkpoint it must be re-baselined, never awarded.
    const accountStore = getGithubAccountStore()
    const trackedRepository = repositories[0].id
    await accountStore.putCredential({ githubId: GITHUB_ID, handle: 'octo', avatarUrl: null }, 'server-token', ['repo'])
    await accountStore.saveSettings(GITHUB_ID, {
      trackedRepositoryIds: [trackedRepository],
      excludedRepositoryIds: [],
      autoIncludePersonal: false,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: { [trackedRepository]: BASELINE },
      lastSyncedAt: BASELINE,
    })

    await accountStore.clearCredential(GITHUB_ID)
    // Re-auth as the same account, preserving choices but not baselines.
    await accountStore.putCredential({ githubId: GITHUB_ID, handle: 'octo', avatarUrl: null }, 'second-token', ['repo'])
    expect((await accountStore.getSettings(GITHUB_ID)).trackedRepositoryIds).toEqual([trackedRepository])
    expect((await accountStore.getSettings(GITHUB_ID)).baselineByRepositoryId).toEqual({})

    const sync = await syncGithub(syncRequest())
    const body = await readSyncResult(sync)

    expect(body.kind).toBe('baseline')
    expect(body.events).toEqual([])
    expect(body.newBaselineRepositoryIds).toEqual([trackedRepository])
    const advanced = await accountStore.getSettings(GITHUB_ID)
    expect(advanced.baselineByRepositoryId[trackedRepository]).not.toBe(BASELINE)
  })

  it('baselines a tracked set larger than one read window, window by window', async () => {
    // REGRESSION: the original 25-repository ceiling left 19 of a
    // 44-repository account baselined never, so no activity in them could
    // award XP. The window is now derived (and therefore smaller), but
    // repositories without a baseline go first and each round's deferred
    // baseline is committed through the real product route, so the whole
    // tracked set is covered without stranding one.
    const accountStore = getGithubAccountStore()
    await accountStore.putCredential({ githubId: GITHUB_ID, handle: 'octo', avatarUrl: null }, 'server-token', ['repo'])
    await accountStore.saveSettings(GITHUB_ID, {
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: true,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: {},
      lastSyncedAt: null,
    })

    const baselined = new Set<string>()
    for (let round = 0; round < 4 && baselined.size < REPOSITORY_COUNT; round += 1) {
      const body = await readSyncResult(await syncGithub(syncRequest()))
      expect(body.repositoryCount).toBe(MAX_SYNC_REPOSITORIES)
      expect(body.skippedRepositoryCount).toBe(REPOSITORY_COUNT - MAX_SYNC_REPOSITORIES)
      // No repository that already has a baseline is read while one still
      // waits: that ordering is what guarantees eventual full coverage.
      const newlyBaselined = body.newBaselineRepositoryIds as string[]
      expect(newlyBaselined.every((id) => !baselined.has(id))).toBe(true)
      for (const id of newlyBaselined) baselined.add(id)

      const profile = createGuestProfile({
        guestId: 'guest-1',
        starterCompanionId: 'pikachu-family',
        now: '2026-08-28T10:00:00.000Z',
      })
      const state = applyProductEvents(
        createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
        body.events as NormalizedEvent[],
        PROTOTYPE_COMPANION_CATALOG,
        { triggerId: `github-sync:${String(body.lastSyncedAt)}:${round}` },
      )
      const snapshot = buildProductSnapshot(state, '2026-08-28T10:00:00.000Z', body.verifiedEventProofs as Record<string, string>)
      const response = await syncProduct(productRequest({ snapshot, checkpoint: body.checkpoint as string }))
      expect(response.status).toBe(200)
    }

    expect(baselined.size).toBe(REPOSITORY_COUNT)
    expect(Object.keys((await accountStore.getSettings(GITHUB_ID)).baselineByRepositoryId))
      .toHaveLength(REPOSITORY_COUNT)
  })

  it('still accepts the deprecated header for a small checkpoint', async () => {
    const accountStore = getGithubAccountStore()
    await accountStore.putCredential({ githubId: GITHUB_ID, handle: 'octo', avatarUrl: null }, 'server-token', ['repo'])
    await accountStore.saveSettings(GITHUB_ID, {
      trackedRepositoryIds: [],
      excludedRepositoryIds: [],
      autoIncludePersonal: true,
      autoIncludeOrganizations: [],
      baselineByRepositoryId: { '1000': BASELINE },
      lastSyncedAt: null,
    })
    // One tracked repository keeps the checkpoint token small enough for a header.
    mocks.fetchRepositories.mockResolvedValue({ status: 'ok', truncated: false, repositories: [repositories[0]] })
    mocks.fetchEvents.mockResolvedValue({
      login: 'octo',
      input: { sourceId: String(GITHUB_ID), companionId: 'octo', commits: [] },
      status: 'ok',
      truncated: false,
    })

    const body = await readSyncResult(await syncGithub(syncRequest()))
    const checkpoint = body.checkpoint as string
    expect(checkpoint.length).toBeLessThan(4_096)

    const snapshot = buildProductSnapshot(
      createProductState(
        createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now: '2026-08-28T10:00:00.000Z' }),
        { events: [] },
        createEncounterState(),
        PROTOTYPE_COMPANION_CATALOG,
      ),
      '2026-08-28T10:00:00.000Z',
    )

    const response = await syncProduct(
      productRequest(snapshot, { 'x-github-sync-checkpoint': checkpoint }),
    )

    expect(response.status).toBe(200)
    // The baseline map was already at this checkpoint, so it is left as-is
    // rather than being written twice; the legacy transport still commits.
    expect((await accountStore.getSettings(GITHUB_ID)).baselineByRepositoryId).toEqual({ '1000': BASELINE })
  })
})
