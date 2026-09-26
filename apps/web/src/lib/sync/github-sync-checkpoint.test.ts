import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  issueGithubSyncCheckpoint,
  MAX_CHECKPOINT_EVENT_IDS,
  MAX_CHECKPOINT_TOKEN_LENGTH,
  verifyGithubSyncCheckpoint,
} from './github-sync-checkpoint'
import {
  MAX_EVENTS_PER_REPOSITORY,
  MAX_SYNC_REPOSITORIES,
} from './sync-schedule'

function eventIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const left = index.toString(16).padStart(8, '0')
    const right = ((index * 2654435761) >>> 0).toString(16).padStart(8, '0')
    return `event-${left}-${right}`
  })
}

describe('GitHub sync checkpoints', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('binds a deferred baseline commit to the account and payload', () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const token = issueGithubSyncCheckpoint({
      githubId: 42,
      previousBaselineByRepositoryId: {},
      nextBaselineByRepositoryId: { '101': '2026-09-14T00:00:00.000Z' },
      nextLastSyncedAt: '2026-09-14T00:00:00.000Z',
      eventIds: ['event-12345678-abcdef12'],
    })

    expect(verifyGithubSyncCheckpoint(token, 42)).toMatchObject({ githubId: 42, eventIds: ['event-12345678-abcdef12'] })
    expect(verifyGithubSyncCheckpoint(token, 43)).toBeNull()
  })

  it('rejects tampering and missing signing configuration', () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const token = issueGithubSyncCheckpoint({
      githubId: 42,
      previousBaselineByRepositoryId: {},
      nextBaselineByRepositoryId: {},
      nextLastSyncedAt: null,
      eventIds: [],
    })
    const [payload, signature] = token.split('.')

    expect(verifyGithubSyncCheckpoint(`${payload}x.${signature}`, 42)).toBeNull()
    vi.stubEnv('SESSION_SECRET', '')
    expect(verifyGithubSyncCheckpoint(token, 42)).toBeNull()
  })

  it('issues and verifies a checkpoint past the old 500-event ceiling', () => {
    // REGRESSION: an account with 44 tracked repositories exceeds 500 event IDs
    // in one sync. The same validator runs at issuance, so the old bound threw
    // and the whole sync failed -- the baseline could never be recorded and no
    // XP could ever bank.
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const ids = eventIds(501)
    const token = issueGithubSyncCheckpoint({
      githubId: 42,
      previousBaselineByRepositoryId: { '101': '2026-09-14T00:00:00.000Z' },
      nextBaselineByRepositoryId: { '101': '2026-09-14T00:00:00.000Z' },
      nextLastSyncedAt: null,
      eventIds: ids,
    })

    expect(verifyGithubSyncCheckpoint(token, 42)?.eventIds).toHaveLength(501)
  })

  it('carries a checkpoint for a whole approved account without a header-sized token', () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    // 500 baseline entries is the repository-listing window's ceiling (5 x 100).
    const baseline = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [String(1000 + index), '2026-09-14T00:00:00.000Z']),
    )
    const token = issueGithubSyncCheckpoint({
      githubId: 42,
      previousBaselineByRepositoryId: baseline,
      nextBaselineByRepositoryId: baseline,
      nextLastSyncedAt: null,
      eventIds: eventIds(1_200),
    })

    const verified = verifyGithubSyncCheckpoint(token, 42)
    expect(Object.keys(verified?.nextBaselineByRepositoryId ?? {})).toHaveLength(500)
    expect(verified?.eventIds).toHaveLength(1_200)
    expect(token.length).toBeLessThan(MAX_CHECKPOINT_TOKEN_LENGTH)
  })

  it('admits a full sync window of worst-case events inside the token bound', () => {
    // REGRESSION GUARD: the event bound is only safe if it is derived from the
    // read window's own worst case. A window of MAX_SYNC_REPOSITORIES
    // repositories, each emitting its fetcher ceiling of
    // MAX_EVENTS_PER_REPOSITORY events, plus both 500-entry baseline maps, must
    // issue, verify, and still fit the token bound -- otherwise the sync route
    // would build a checkpoint its own validator rejects and fail in-band.
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const worstCase = MAX_SYNC_REPOSITORIES * MAX_EVENTS_PER_REPOSITORY
    expect(worstCase).toBeGreaterThan(0)
    expect(worstCase).toBeLessThanOrEqual(MAX_CHECKPOINT_EVENT_IDS)

    // Real 19-digit-looking repository ids, so the size claim is not
    // flattered by short fixture keys.
    const baseline = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        String(index).padStart(19, '0'),
        '2026-09-14T00:00:00.000Z',
      ]),
    )
    const token = issueGithubSyncCheckpoint({
      githubId: 42,
      previousBaselineByRepositoryId: baseline,
      nextBaselineByRepositoryId: baseline,
      nextLastSyncedAt: '2026-09-14T00:05:00.000Z',
      eventIds: eventIds(worstCase),
    })

    const verified = verifyGithubSyncCheckpoint(token, 42)
    expect(verified?.eventIds).toHaveLength(worstCase)
    expect(Object.keys(verified?.nextBaselineByRepositoryId ?? {})).toHaveLength(500)
    expect(token.length).toBeLessThanOrEqual(MAX_CHECKPOINT_TOKEN_LENGTH)
  })

  it('still refuses duplicate, malformed, and unbounded event lists', () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const base = {
      githubId: 42,
      previousBaselineByRepositoryId: {},
      nextBaselineByRepositoryId: {},
      nextLastSyncedAt: null,
    }

    expect(() => issueGithubSyncCheckpoint({ ...base, eventIds: ['event-12345678-abcdef12', 'event-12345678-abcdef12'] }))
      .toThrow(TypeError)
    expect(() => issueGithubSyncCheckpoint({ ...base, eventIds: ['event-not-a-real-id'] }))
      .toThrow(TypeError)
    expect(() => issueGithubSyncCheckpoint({ ...base, eventIds: eventIds(MAX_CHECKPOINT_EVENT_IDS + 1) }))
      .toThrow(TypeError)
  })
})
