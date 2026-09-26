/**
 * Pure transform from stored users to leaderboard rows. No fetching here:
 * `getFollowing` and `SyncStore.getMany` happen in the page, this just
 * shapes and sorts the result, which is what makes it cheap to unit test.
 *
 * PRIVACY: a synced account is PRIVATE by default, and the leaderboard is a
 * public-ish surface (anyone who follows you can see your row). Rows are
 * therefore filtered to accounts that explicitly opted in, with one exception:
 * the viewer always sees their OWN row, so the page does not look empty to
 * someone who simply has not opted in yet.
 */
import type { LeaderboardEntry, SyncedUser } from './types'

export interface BuildLeaderboardOptions {
  /**
   * GitHub ids that have opted in to a public profile. When omitted, every
   * user is treated as visible (the pre-privacy behavior) so existing callers
   * and tests keep working; the page always passes this.
   */
  publicGithubIds?: ReadonlySet<number>
}

export function buildLeaderboardEntries(
  users: readonly SyncedUser[],
  viewerHandle: string | null,
  options: BuildLeaderboardOptions = {},
): LeaderboardEntry[] {
  const lowerViewer = viewerHandle?.toLowerCase() ?? null

  return users
    .filter((user) => {
      const isViewer = lowerViewer !== null && user.handle.toLowerCase() === lowerViewer
      if (isViewer) return true
      // No visibility set provided means the caller has not opted into
      // filtering; omit nothing (backwards-compatible).
      if (!options.publicGithubIds) return true
      return options.publicGithubIds.has(user.githubId)
    })
    .map((user) => ({
      handle: user.handle,
      avatarUrl: user.avatarUrl,
      totalXp: user.snapshot.totalXp,
      stage: user.snapshot.stage,
      stageIndex: user.snapshot.stageIndex,
      companionCount: user.snapshot.companions.length,
      isViewer: lowerViewer !== null && user.handle.toLowerCase() === lowerViewer,
    }))
    .sort((a, b) => b.totalXp - a.totalXp)
}
