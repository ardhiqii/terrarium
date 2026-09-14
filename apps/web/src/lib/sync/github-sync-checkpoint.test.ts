import { afterEach, describe, expect, it, vi } from 'vitest'
import { issueGithubSyncCheckpoint, verifyGithubSyncCheckpoint } from './github-sync-checkpoint'

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
})
