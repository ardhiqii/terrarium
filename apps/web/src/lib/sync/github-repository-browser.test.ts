import { describe, expect, it } from 'vitest'
import { filterGithubRepositories, type RepositoryScope } from './github-repository-browser'
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
