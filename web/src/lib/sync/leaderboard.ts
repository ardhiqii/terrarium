/**
 * Pure transform from stored users to leaderboard rows. No fetching here:
 * `getFollowing` and `SyncStore.getMany` happen in the page, this just
 * shapes and sorts the result, which is what makes it cheap to unit test.
 */
import type { LeaderboardEntry, SyncedUser } from './types'

export function buildLeaderboardEntries(
  users: readonly SyncedUser[],
  viewerHandle: string | null
): LeaderboardEntry[] {
  const lowerViewer = viewerHandle?.toLowerCase() ?? null

  return users
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
