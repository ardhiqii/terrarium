import type { GitHubEventNormalizationInput } from '@/lib/game/github-events'
import type { GithubRepository } from './github-repositories'
import { MAX_SYNC_REPOSITORIES } from './sync-schedule'
import type { GithubAccountSettings } from './github-account-store'

/**
 * The repository window is shared by normal sync and receipt repair. Keeping
 * the policy in one server-safe module prevents repair from accidentally
 * reading a repository the account did not approve, or from widening the
 * normal 16-repository request window.
 */
export function repositoryIsTracked(
  repository: GithubRepository,
  settings: GithubAccountSettings,
): boolean {
  if (!repository.canRead || repository.archived) return false
  if (settings.excludedRepositoryIds.includes(repository.id)) return false
  if (settings.trackedRepositoryIds.includes(repository.id)) return true
  if (repository.ownerType === 'User' && settings.autoIncludePersonal) return true
  return settings.autoIncludeOrganizations.includes(repository.ownerLogin.toLowerCase())
}

export interface GithubRepositoryWindow {
  readonly eligible: readonly GithubRepository[]
  readonly eligibleCandidateCount: number
  readonly skippedCount: number
}

/**
 * Select the same bounded window as `/api/github/sync`. Repositories without a
 * baseline go first because they cannot award history until their first read is
 * committed. The repair path uses this ordering too, so a large account never
 * turns a recovery request into an unbounded GitHub scan.
 */
export function selectGithubRepositoryWindow(
  repositories: readonly GithubRepository[],
  settings: GithubAccountSettings,
): GithubRepositoryWindow {
  const candidates = repositories.filter((repository) => repositoryIsTracked(repository, settings))
  const eligible = [
    ...candidates.filter((repository) => !settings.baselineByRepositoryId[repository.id]),
    ...candidates.filter((repository) => Boolean(settings.baselineByRepositoryId[repository.id])),
  ].slice(0, MAX_SYNC_REPOSITORIES)
  return {
    eligible,
    eligibleCandidateCount: candidates.length,
    skippedCount: Math.max(0, candidates.length - eligible.length),
  }
}

export function occurredAfterBaseline(
  repositoryId: string,
  occurredAt: string,
  baselines: Readonly<Record<string, string>>,
): boolean {
  const baseline = baselines[repositoryId]
  if (!baseline) return false
  const eventTime = Date.parse(occurredAt)
  const baselineTime = Date.parse(baseline)
  return Number.isFinite(eventTime) && Number.isFinite(baselineTime) && eventTime > baselineTime
}

/** Keep only activity eligible for a normal deferred-baseline sync. */
export function filterInputAfterBaselines(
  input: GitHubEventNormalizationInput,
  baselines: Readonly<Record<string, string>>,
): GitHubEventNormalizationInput {
  return {
    ...input,
    commits: input.commits?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.occurredAt, baselines),
    ),
    mergedPullRequests: input.mergedPullRequests?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.mergedAt, baselines),
    ),
    releases: input.releases?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.publishedAt, baselines),
    ),
    linkedIssues: input.linkedIssues?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.closedAt, baselines),
    ),
    ciChecks: input.ciChecks?.filter((record) =>
      occurredAfterBaseline(record.repositoryId, record.completedAt, baselines),
    ),
  }
}
