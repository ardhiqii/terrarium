import { describe, expect, it } from 'vitest'
import { asCompanionId, type NormalizedEvent } from './events'
import {
  normalizeGitHubEvents,
  type GitHubEventNormalizationInput,
} from './github-events'

const baseInput: GitHubEventNormalizationInput = {
  sourceId: 'account-42',
  companionId: asCompanionId('companion-a'),
}

function normalize(
  overrides: Partial<GitHubEventNormalizationInput> = {},
): readonly NormalizedEvent[] {
  return normalizeGitHubEvents({ ...baseInput, ...overrides })
}

describe('normalizeGitHubEvents', () => {
  it('ignores empty, generated-only, and unchanged-metadata commits', () => {
    const events = normalize({
      commits: [
        {
          id: 'empty',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T09:00:00Z',
          changedFiles: 0,
          additions: 0,
          deletions: 0,
        },
        {
          id: 'generated',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T10:00:00Z',
          generatedOnly: true,
          changedFiles: 1,
          additions: 50,
        },
        {
          id: 'metadata',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T11:00:00Z',
          unchangedMetadata: true,
          changedFiles: 1,
          additions: 1,
        },
      ],
    })

    expect(events).toEqual([])
  })

  it('ignores commits whose changed paths are only generated artifacts', () => {
    const events = normalize({
      commits: [
        {
          id: 'generated-paths',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T09:00:00Z',
          changedFiles: 2,
          additions: 12,
          changedPaths: ['dist/app.js', 'dist/app.js.map'],
        },
      ],
    })

    expect(events).toEqual([])
  })

  it('deduplicates repeated source IDs and emits verified source metadata', () => {
    const events = normalize({
      commits: [
        {
          id: 'commit-1',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T09:00:00Z',
          changedFiles: 1,
          additions: 2,
        },
        {
          id: 'commit-1',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T09:00:00Z',
          changedFiles: 1,
          additions: 2,
        },
      ],
    })

    expect(events).toHaveLength(2)
    expect(events.every((event) => event.sourceId === 'account-42')).toBe(true)
    expect(events.every((event) => event.provenance === 'verified')).toBe(true)
    expect(events.find((event) => event.category === 'work-session')?.metadata).toEqual({
      activityCount: 1,
      sessionBucket: '2026-08-28-04',
    })
  })

  it('creates one deterministic session per two-hour UTC bucket', () => {
    const forward = normalize({
      commits: [
        {
          id: 'late',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T06:00:00Z',
          changedFiles: 1,
          additions: 1,
        },
        {
          id: 'early',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T04:01:00Z',
          changedFiles: 1,
          additions: 1,
        },
      ],
    })
    const reverse = normalize({
      commits: [
        {
          id: 'early',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T04:01:00Z',
          changedFiles: 1,
          additions: 1,
        },
        {
          id: 'late',
          repositoryId: 'repo-1',
          occurredAt: '2026-08-28T06:00:00Z',
          changedFiles: 1,
          additions: 1,
        },
      ],
    })

    expect(forward).toEqual(reverse)
    expect(forward.filter((event) => event.category === 'work-session')).toHaveLength(2)
  })

  it('normalizes merged PRs, releases, and only linked closed issues', () => {
    const events = normalize({
      mergedPullRequests: [
        {
          id: 'pr-7',
          repositoryId: 'repo-1',
          number: 7,
          mergedAt: '2026-08-28T12:00:00Z',
        },
      ],
      releases: [
        {
          id: 'release-1',
          repositoryId: 'repo-1',
          tagName: 'v1.0.0',
          publishedAt: '2026-08-28T13:00:00Z',
        },
      ],
      linkedIssues: [
        {
          id: 'issue-linked',
          repositoryId: 'repo-1',
          number: 10,
          closedAt: '2026-08-28T14:00:00Z',
          linkedPullRequestId: 'pr-7',
        },
        {
          id: 'issue-unlinked',
          repositoryId: 'repo-1',
          number: 11,
          closedAt: '2026-08-28T14:00:00Z',
        },
      ],
    })

    expect(events.map((event) => event.category)).toEqual([
      'qualifying-active-day',
      'merged-pull-request',
      'published-release',
      'closed-linked-issue',
    ])
    expect(events.find((event) => event.category === 'closed-linked-issue')?.metadata).toEqual({
      repositoryId: 'repo-1',
      number: 10,
      linkedPullRequestId: 'pr-7',
    })
  })

  it('emits one successful CI event per merged PR and ignores unrelated checks', () => {
    const events = normalize({
      mergedPullRequests: [
        {
          id: 'pr-7',
          repositoryId: 'repo-1',
          number: 7,
          mergedAt: '2026-08-28T12:00:00Z',
        },
      ],
      ciChecks: [
        {
          id: 'check-later',
          repositoryId: 'repo-1',
          completedAt: '2026-08-28T12:05:00Z',
          conclusion: 'success',
          pullRequestId: 'pr-7',
          name: 'test',
        },
        {
          id: 'check-earlier',
          repositoryId: 'repo-1',
          completedAt: '2026-08-28T12:04:00Z',
          conclusion: 'success',
          pullRequestId: 'pr-7',
          name: 'lint',
        },
        {
          id: 'check-failure',
          repositoryId: 'repo-1',
          completedAt: '2026-08-28T12:06:00Z',
          conclusion: 'failure',
          pullRequestId: 'pr-7',
        },
        {
          id: 'check-unrelated',
          repositoryId: 'repo-1',
          completedAt: '2026-08-28T12:07:00Z',
          conclusion: 'success',
          pullRequestId: 'pr-other',
        },
      ],
    })

    const ciEvents = events.filter((event) => event.category === 'successful-ci')
    expect(ciEvents).toHaveLength(1)
    expect(ciEvents[0].occurredAt).toBe('2026-08-28T12:04:00.000Z')
    expect(ciEvents[0].metadata).toEqual({
      repositoryId: 'repo-1',
      pullRequestId: 'pr-7',
      checkName: 'lint',
    })
  })

  it('attaches daily active-day and two-session caps', () => {
    const events = normalize({
      commits: [
        ...Array.from({ length: 4 }, (_, index) => ({
          id: `commit-${index}`,
          repositoryId: 'repo-1',
          occurredAt: `2026-08-28T${String(2 + index * 2).padStart(2, '0')}:00:00Z`,
          changedFiles: 1,
          additions: 1,
        })),
      ],
    })
    const activeDay = events.find((event) => event.category === 'qualifying-active-day')
    const sessions = events.filter((event) => event.category === 'work-session')

    expect(activeDay?.cap).toEqual({
      key: 'github:account-42:2026-08-28:qualifying-active-day',
      limit: 1,
    })
    expect(sessions).toHaveLength(4)
    expect(sessions.every((event) => event.cap?.limit === 2)).toBe(true)
    expect(new Set(sessions.map((event) => event.cap?.key))).toEqual(
      new Set(['github:account-42:2026-08-28:work-session']),
    )
  })

  it('is deterministic when records arrive in a different order', () => {
    const records = {
      commits: [
        {
          id: 'commit-b',
          repositoryId: 'repo-2',
          occurredAt: '2026-08-28T16:00:00Z',
          changedFiles: 1,
          additions: 1,
        },
      ],
      mergedPullRequests: [
        {
          id: 'pr-1',
          repositoryId: 'repo-1',
          mergedAt: '2026-08-28T08:00:00Z',
        },
      ],
    } as const

    expect(normalize(records)).toEqual(
      normalize({
        commits: [...records.commits].reverse(),
        mergedPullRequests: [...records.mergedPullRequests].reverse(),
      }),
    )
  })
})
