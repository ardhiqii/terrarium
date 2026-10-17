import { describe, expect, it } from 'vitest'
import { filterGithubRepositories, mergeSelectableTrackedIds, selectableRepositoryIds, type RepositoryScope } from './github-repository-browser'
import type { GithubRepository } from './github-repositories'

function repository(overrides: Partial<GithubRepository> = {}): GithubRepository {
  return {
    id: '1',
    name: 'garden',
    fullName: 'ardhiqii/garden',
    ownerLogin: 'ardhiqii',
    ownerType: 'User',
    private: false,
    visibility: 'public',
    defaultBranch: 'main',
    archived: false,
    canRead: true,
    ...overrides,
  }
}

describe('filterGithubRepositories', () => {
  const repositories = [
    repository(),
    repository({ id: '2', name: 'Terrarium Notes', fullName: 'ardhiqii/Terrarium-Notes' }),
    repository({ id: '3', name: 'team-tools', fullName: 'Acme/team-tools', ownerLogin: 'Acme', ownerType: 'Organization' }),
  ]

  it.each([
    ['all', 3],
    ['user', 2],
    ['organization', 1],
  ] as const)('filters the %s source scope', (scope: RepositoryScope, expectedCount: number) => {
    expect(filterGithubRepositories(repositories, '', scope)).toHaveLength(expectedCount)
  })

  it('matches repository names and full owner paths case-insensitively', () => {
    expect(filterGithubRepositories(repositories, 'TERRARIUM NOTES', 'all').map((repo) => repo.id)).toEqual(['2'])
    expect(filterGithubRepositories(repositories, 'acme/', 'all').map((repo) => repo.id)).toEqual(['3'])
  })

  it('combines the query with the owner scope', () => {
    expect(filterGithubRepositories(repositories, 'team', 'user')).toEqual([])
    expect(filterGithubRepositories(repositories, 'team', 'organization').map((repo) => repo.id)).toEqual(['3'])
  })
})

describe('selectableRepositoryIds', () => {
  it('returns readable, non-archived IDs in listing order', () => {
    expect(selectableRepositoryIds([
      repository({ id: '2' }),
      repository({ id: '3', canRead: false }),
      repository({ id: '4', archived: true }),
    ])).toEqual(['2'])
  })
})

describe('mergeSelectableTrackedIds', () => {
  it('adds every selectable repository to the current selection', () => {
    expect(mergeSelectableTrackedIds(['1'], [repository(), repository({ id: '2' })])).toEqual(['1', '2'])
  })

  it('keeps tracked IDs the listing cannot show instead of releasing them', () => {
    // REGRESSION: replacing the draft with only the visible IDs released a
    // repository whose listing read came back short, so "Select all" appeared
    // to unselect itself after a sync.
    expect(mergeSelectableTrackedIds(['1', '99'], [repository()])).toEqual(['1', '99'])
  })

  it('never adds archived or unreadable repositories and drops duplicates', () => {
    expect(mergeSelectableTrackedIds(['1'], [
      repository({ archived: true }),
      repository({ id: '2', canRead: false }),
      repository({ id: '3' }),
      repository({ id: '3', name: 'duplicate' }),
    ])).toEqual(['1', '3'])
  })
})
