import type { GitHubEventNormalizationInput } from '@/lib/game/github-events'
import type { GithubRepository } from './github-repositories'
import { MAX_SYNC_REPOSITORIES } from './sync-schedule'
import type { GithubAccountSettings } from './github-account-store'

/**
 * The repository window is shared by normal sync and receipt repair. Keeping
 * the policy in one server-safe module prevents repair from accidentally
 * reading a repository the account did not approve, or from widening the
 * normal derived repository window.
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
 * committed; after that, the oldest successful baselines rotate forward so a
 * large account is not pinned to the first page forever. The repair path uses
 * this ordering too, so a recovery request never becomes an unbounded scan.
 */
export function selectGithubRepositoryWindow(
  repositories: readonly GithubRepository[],
  settings: GithubAccountSettings,
): GithubRepositoryWindow {
  const candidates = repositories.filter((repository) => repositoryIsTracked(repository, settings))
  const eligible = [...candidates]
    .sort((left, right) => {
      const leftBaseline = Date.parse(settings.baselineByRepositoryId[left.id] ?? '')
      const rightBaseline = Date.parse(settings.baselineByRepositoryId[right.id] ?? '')
      const leftRank = Number.isFinite(leftBaseline) ? leftBaseline : Number.NEGATIVE_INFINITY
      const rightRank = Number.isFinite(rightBaseline) ? rightBaseline : Number.NEGATIVE_INFINITY
      return leftRank - rightRank || left.id.localeCompare(right.id)
    })
    .slice(0, MAX_SYNC_REPOSITORIES)
  return {
    eligible,
    eligibleCandidateCount: candidates.length,
    skippedCount: Math.max(0, candidates.length - eligible.length),
  }
}

export interface GithubSyncRepositorySelection {
  /** Repositories whose read can award activity: oldest baselines rotate first. */
  readonly readWindow: readonly GithubRepository[]
  /** Repositories awaiting their first baseline: recorded without any read. */
  readonly pendingBaseline: readonly GithubRepository[]
  readonly eligibleCandidateCount: number
  /** Repositories the sync after this one still has to cover. */
  readonly skippedCount: number
}

/**
 * Select the window for `/api/github/sync`.
 *
 * A repository without a baseline needs no historical read: its first
 * successful listing records the baseline and cannot award old history. It is
 * registered in the same sync, in full, instead of occupying one of the four
 * read slots — an account used to need one silent sync per four repositories
 * before any activity could be read at all. The read window keeps the bounded
 * rotation: oldest successful baselines first, so a large account is not
 * pinned to the same repositories forever.
 *
 * `maxBaselineRegistrations` bounds how many first-use baselines one signed
 * checkpoint may carry; it comes from the checkpoint's baseline-map capacity,
 * not from the read window's request budget.
 */
export function selectGithubSyncRepositories(
  repositories: readonly GithubRepository[],
  settings: GithubAccountSettings,
  maxBaselineRegistrations: number,
): GithubSyncRepositorySelection {
  const candidates = repositories.filter((repository) => repositoryIsTracked(repository, settings))
  const withBaseline: GithubRepository[] = []
  const withoutBaseline: GithubRepository[] = []
  for (const repository of candidates) {
    const baseline = Date.parse(settings.baselineByRepositoryId[repository.id] ?? '')
    if (Number.isFinite(baseline)) withBaseline.push(repository)
    else withoutBaseline.push(repository)
  }
  withBaseline.sort((left, right) => {
    const leftBaseline = Date.parse(settings.baselineByRepositoryId[left.id] ?? '')
    const rightBaseline = Date.parse(settings.baselineByRepositoryId[right.id] ?? '')
    return leftBaseline - rightBaseline || left.id.localeCompare(right.id)
  })
  const budget = Math.max(0, Math.floor(maxBaselineRegistrations))
  const pendingBaseline = withoutBaseline.slice(0, budget)
  const readWindow = withBaseline.slice(0, MAX_SYNC_REPOSITORIES)
  return {
    readWindow,
    pendingBaseline,
    eligibleCandidateCount: candidates.length,
    skippedCount: Math.max(0, candidates.length - readWindow.length - pendingBaseline.length),
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
  // GitHub timestamps are second-granular while checkpoints carry
  // milliseconds. Include the boundary second; stable event IDs make the
  // one-second overlap idempotent and prevent activity from being lost.
  const boundary = Number.isFinite(baselineTime) ? Math.floor(baselineTime / 1000) * 1000 : Number.NaN
  return Number.isFinite(eventTime) && Number.isFinite(boundary) && eventTime >= boundary
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
