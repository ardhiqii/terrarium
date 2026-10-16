import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  githubSyncContinuationMatchesBaseline,
  issueGithubSyncContinuation,
  verifyGithubSyncContinuation,
} from './github-sync-continuation'

describe('GitHub sync continuations', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('binds a bounded cursor to the account and current baseline without serializing the map', () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const baseline = Object.fromEntries(
      Array.from({ length: 450 }, (_, index) => [String(index + 1), '2026-09-01T00:00:00.000Z']),
    )
    const token = issueGithubSyncContinuation({
      githubId: 9001,
      baselineByRepositoryId: baseline,
      cursors: { '101': { pullRequestsPage: 4 } },
    })

    expect(token.length).toBeLessThan(16 * 1024)
    const verified = verifyGithubSyncContinuation(token, 9001)
    expect(verified?.cursors).toEqual({ '101': { pullRequestsPage: 4 } })
    expect(verified?.baselineByRepositoryId).toBeUndefined()
    expect(githubSyncContinuationMatchesBaseline(verified!, baseline)).toBe(true)
    expect(githubSyncContinuationMatchesBaseline(verified!, { ...baseline, '451': '2026-09-02T00:00:00.000Z' })).toBe(false)
    expect(verifyGithubSyncContinuation(token, 9002)).toBeNull()
  })

  it('rejects tampered and expired tokens', () => {
    vi.stubEnv('SESSION_SECRET', 's'.repeat(32))
    const token = issueGithubSyncContinuation({
      githubId: 9001,
      baselineByRepositoryId: {},
      cursors: { '101': { page: 4 } },
    })
    const separator = token.lastIndexOf('.')
    const tampered = `${token.slice(0, separator)}x${token.slice(separator)}`
    expect(verifyGithubSyncContinuation(tampered, 9001)).toBeNull()

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
    const old = issueGithubSyncContinuation({
      githubId: 9001,
      baselineByRepositoryId: {},
      cursors: { '101': { page: 4 } },
    })
    vi.setSystemTime(new Date('2026-09-03T00:00:01.000Z'))
    expect(verifyGithubSyncContinuation(old, 9001)).toBeNull()
  })
})
