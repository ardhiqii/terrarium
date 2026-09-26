import { describe, expect, it } from 'vitest'
import { selectGithubRepositoryWindow, repositoryIsTracked, filterInputAfterBaselines } from './github-source-policy'
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
    expect(selected.eligible.length).toBe(16)
    expect(selected.skippedCount).toBe(4)
  })

  it('filters normal activity strictly after the stored baseline', () => {
    const input = {
      sourceId: '9001',
      companionId: 'pikachu-family',
      commits: [
        { id: 'old', repositoryId: '1', occurredAt: '2026-01-01T00:00:00Z' },
        { id: 'new', repositoryId: '1', occurredAt: '2026-01-02T00:00:00Z' },
      ],
    }
    const filtered = filterInputAfterBaselines(input, { '1': '2026-01-01T00:00:00Z' })
    expect(filtered.commits?.map((commit) => commit.id)).toEqual(['new'])
  })
})
