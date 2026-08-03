/**
 * Commit-streak maths. Pure, with no `fs` and no network.
 *
 * This lives in its own module rather than in `github.ts` because
 * `repo-creature.ts` needs it, and `repo-creature.ts` is imported by client
 * components. `github.ts` reads a cache file with `node:fs`, so importing this
 * function from there dragged the whole filesystem module into the browser
 * bundle and every route failed to compile.
 *
 * T10 was right to delete the duplicated copy of this function. The mistake was
 * leaving the survivor inside a module bound to the filesystem. One
 * implementation, in a module that depends on nothing.
 */

/**
 * Consecutive days up to today with at least one commit. If today has no commit
 * yet, that does not zero the streak (the day is not over), so the walk starts
 * from yesterday in that case.
 */
export function computeCurrentStreak(
  commitsByDay: Record<string, number>
): number {
  const toDayString = (d: Date): string => d.toISOString().slice(0, 10)

  const cursor = new Date()
  cursor.setUTCHours(0, 0, 0, 0)

  if (!(commitsByDay[toDayString(cursor)] > 0)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }

  let streak = 0
  while (commitsByDay[toDayString(cursor)] > 0) {
    streak++
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }

  return streak
}
