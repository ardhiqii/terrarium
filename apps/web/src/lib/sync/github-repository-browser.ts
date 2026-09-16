import type { GithubRepository } from './github-repositories'

export type RepositoryScope = 'all' | 'user' | 'organization'

export function filterGithubRepositories(
  repositories: readonly GithubRepository[],
  query: string,
  scope: RepositoryScope,
): GithubRepository[] {
  const normalizedQuery = query.trim().toLowerCase()
  return repositories.filter((repository) => {
    const matchesQuery = normalizedQuery.length === 0 ||
      repository.name.toLowerCase().includes(normalizedQuery) ||
      repository.fullName.toLowerCase().includes(normalizedQuery)
    const matchesScope = scope === 'all' ||
      (scope === 'user' ? repository.ownerType === 'User' : repository.ownerType === 'Organization')
    return matchesQuery && matchesScope
  })
}
