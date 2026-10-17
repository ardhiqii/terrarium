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

/** Repository IDs this listing can offer for tracking right now. */
export function selectableRepositoryIds(
  repositories: readonly GithubRepository[],
): string[] {
  return repositories
    .filter((repository) => repository.canRead && !repository.archived)
    .map((repository) => repository.id)
}

/**
 * Add every currently selectable repository to an existing tracked selection
 * instead of replacing it.
 *
 * Select-all must never release a tracked repository this listing cannot show
 * at the moment -- a short provider page, an organization grant mid-refresh,
 * or a browser copy that lost rows. The stored ID survives, and the selection
 * heals itself when the listing returns in full.
 */
export function mergeSelectableTrackedIds(
  current: readonly string[],
  repositories: readonly GithubRepository[],
): string[] {
  return [...new Set([...current, ...selectableRepositoryIds(repositories)])]
}
