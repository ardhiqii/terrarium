import { describe, expect, it } from 'vitest'
import { selectGithubRepositoryWindow, selectGithubSyncRepositories, repositoryIsTracked, filterInputAfterBaselines } from './github-source-policy'
import type { GithubAccountSettings } from './github-account-store'
import type { GithubRepository } from './github-repositories'

const settings: GithubAccountSettings = {
  trackedRepositoryIds: ['1'],
  excludedRepositoryIds: [],
  autoIncludePersonal: false,
  autoIncludeOrganizations: [],
  baselineByRepositoryId: {},
  lastSyncedAt: null,
}

function repository(id: string, ownerType: 'User' | 'Organization' = 'User'): GithubRepository {
  return {
    id,
    name: `repo-${id}`,
    fullName: `octo/repo-${id}`,
    ownerLogin: ownerType === 'User' ? 'octo' : 'acme',
    ownerType,
    private: true,
    visibility: 'private',
    defaultBranch: 'main',
    archived: false,
    canRead: true,
  }
}

describe('GitHub source policy', () => {
  it('fails closed for archived, unreadable, excluded, and unapproved repositories', () => {
    expect(repositoryIsTracked(repository('1'), settings)).toBe(true)
    expect(repositoryIsTracked({ ...repository('1'), archived: true }, settings)).toBe(false)
    expect(repositoryIsTracked({ ...repository('1'), canRead: false }, settings)).toBe(false)
    expect(repositoryIsTracked(repository('2'), settings)).toBe(false)
    expect(repositoryIsTracked(repository('2', 'Organization'), {
      ...settings,
      autoIncludeOrganizations: ['acme'],
    })).toBe(true)
  })

  it('keeps the repair and normal sync window at MAX_SYNC_REPOSITORIES', () => {
    const repositories = Array.from({ length: 20 }, (_, index) => repository(String(index + 1)))
    const selected = selectGithubRepositoryWindow(repositories, {
      ...settings,
      trackedRepositoryIds: [],
      autoIncludePersonal: true,
    })
    expect(selected.eligible.length).toBe(4)
    expect(selected.skippedCount).toBe(16)
  })

  it('rotates the oldest successful baselines after new repositories', () => {
    const repositories = Array.from({ length: 8 }, (_, index) => repository(String(index + 1)))
    const selected = selectGithubRepositoryWindow(repositories, {
      ...settings,
      trackedRepositoryIds: [],
      autoIncludePersonal: true,
      baselineByRepositoryId: Object.fromEntries(
        repositories.map((entry, index) => [entry.id, `2026-09-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`]),
      ),
    })

    expect(selected.eligible.map((entry) => entry.id)).toEqual(['1', '2', '3', '4'])
    expect(selectGithubRepositoryWindow(repositories, {
      ...settings,
      trackedRepositoryIds: [],
      autoIncludePersonal: true,
      baselineByRepositoryId: Object.fromEntries(
        repositories.map((entry, index) => [entry.id, `2026-09-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`]),
      ),
    }).skippedCount).toBe(4)
  })

  it('registers repositories awaiting a baseline without spending read slots on them', () => {
    const repositories = Array.from({ length: 8 }, (_, index) => repository(String(index + 1)))
    const selected = selectGithubSyncRepositories(repositories, {
      ...settings,
      trackedRepositoryIds: [],
      autoIncludePersonal: true,
      baselineByRepositoryId: {
        '1': '2026-09-01T00:00:00.000Z',
        '2': '2026-01-01T00:00:00.000Z',
      },
    }, 500)

    // Only repositories that can award are read: the oldest baselines first.
    expect(selected.readWindow.map((entry) => entry.id)).toEqual(['2', '1'])
    // Every repository still awaiting a baseline is registered, in the same
    // sync, in listing order.
    expect(selected.pendingBaseline.map((entry) => entry.id)).toEqual(['3', '4', '5', '6', '7', '8'])
    expect(selected.eligibleCandidateCount).toBe(8)
    expect(selected.skippedCount).toBe(0)
  })

  it('bounds first-use baselines by the checkpoint capacity and reports the rest as skipped', () => {
    const repositories = Array.from({ length: 6 }, (_, index) => repository(String(index + 1)))
    const selected = selectGithubSyncRepositories(repositories, {
      ...settings,
      trackedRepositoryIds: [],
      autoIncludePersonal: true,
    }, 2)

    expect(selected.pendingBaseline.map((entry) => entry.id)).toEqual(['1', '2'])
    expect(selected.readWindow).toEqual([])
    expect(selected.skippedCount).toBe(4)
  })

  it('rotates the read window through the oldest baselines when every repository is registered', () => {
    const repositories = Array.from({ length: 6 }, (_, index) => repository(String(index + 1)))
    const selected = selectGithubSyncRepositories(repositories, {
      ...settings,
      trackedRepositoryIds: [],
      autoIncludePersonal: true,
      baselineByRepositoryId: Object.fromEntries(
        repositories.map((entry, index) => [entry.id, `2026-09-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`]),
      ),
    }, 500)

    expect(selected.readWindow.map((entry) => entry.id)).toEqual(['1', '2', '3', '4'])
    expect(selected.pendingBaseline).toEqual([])
    expect(selected.skippedCount).toBe(2)
  })

  it('filters normal activity at or after the stored baseline', () => {
    const input = {
      sourceId: '9001',
      companionId: 'pikachu-family',
      commits: [
        { id: 'before', repositoryId: '1', occurredAt: '2025-12-31T23:59:59Z' },
        { id: 'boundary', repositoryId: '1', occurredAt: '2026-01-01T00:00:00Z' },
        { id: 'new', repositoryId: '1', occurredAt: '2026-01-02T00:00:00Z' },
      ],
    }
    const filtered = filterInputAfterBaselines(input, { '1': '2026-01-01T00:00:00.500Z' })
    expect(filtered.commits?.map((commit) => commit.id)).toEqual(['boundary', 'new'])
  })
})
