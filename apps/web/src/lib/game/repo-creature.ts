/**
 * Composes `CreatureState` for callers that are NOT the site owner's own
 * build-time render: another GitHub handle's garden creature, or a single
 * repo's creature.
 *
 * Why this exists instead of reusing `getCreatureState()` directly: that
 * function (state.ts, must-not-touch) unconditionally calls
 * `getGardenStats()`, which reads THIS repo's local MDX content. There is no
 * parameter to swap that out. Calling it for an arbitrary handle would
 * silently hand them the site owner's note count, word count, backlinks,
 * and so on. That is exactly the bug this task calls out as the
 * highest-risk part of T6.
 *
 * So: the owner path in the route handler calls `getCreatureState(github)`
 * directly (correct reuse, real local stats). Every other path builds its
 * `CreatureState` here, from a `GardenStats` that is either fully zeroed
 * (garden creature for a stranger) or represents a single repo's commit
 * activity only (repo creature), using the exact same `resolveStage`,
 * `computeGardenXp`, `computeCommitXp` pipeline that `state.ts` uses. The
 * arithmetic is identical; only which `GardenStats` feeds it differs.
 */

import { computeGardenXp, computeCommitXp } from './xp'
import { resolveStage } from './stages'
import { ITEMS, COMMIT_ITEMS } from './items'
// From `./streak`, NOT `./github`: that module reads a cache file with
// `node:fs`, and importing it here pulls the filesystem into every client
// bundle that touches the creature pipeline.
import { computeCurrentStreak } from './streak'
import {
  CreatureState,
  GardenStats,
  GithubStats,
  ItemState,
  Maturity,
  MATURITIES,
  UnlockContext,
} from './types'

/**
 * A `GardenStats` with every field zeroed. Used for any handle that is not
 * the site owner: they have no garden here, so their garden stats are
 * genuinely zero, not omitted and not borrowed from the owner's content.
 */
export function emptyGardenStats(): GardenStats {
  const maturityCounts = {} as Record<Maturity, number>
  for (const m of MATURITIES) maturityCounts[m] = 0

  return {
    noteCount: 0,
    projectCount: 0,
    totalWords: 0,
    resolvedWikilinks: 0,
    backlinksReceived: 0,
    tagCount: 0,
    maturityCounts,
    maxBacklinksOnSingleNote: 0,
    firstPublishedAt: null,
    lastPublishedAt: null,
  }
}

export interface ComposeOptions {
  /** Whether to compute the item drawer at all. Defaults to true. */
  includeItems?: boolean
  /**
   * Whether this state represents the site owner's own build. Defaults to
   * `true` for backward compatibility with `state.ts`, the one caller that
   * predates this option and always represents the owner's own build (real
   * garden stats, real local content).
   *
   * Governs two things:
   * 1. Which items apply. The owner gets `ITEMS` (garden items plus commit
   *    items); everyone else gets `COMMIT_ITEMS` only. `items.ts`'s garden
   *    items (Spore Jar, Dew Vial, Hand Lens, Trowel, Field Ledger, Brass
   *    Compass, Pressed Frond) need a garden to mean anything, and a
   *    non-owner creature's `stats` is genuinely zeroed (see
   *    `emptyGardenStats` below), so shipping those as permanently-locked
   *    noise on a creature that can never earn them would be worse than not
   *    showing them.
   * 2. `ctx.isOwner`, passed straight through to `UnlockContext` so
   *    `items.ts`'s `getActiveDays()` only reads local garden content
   *    (`getAllContent()`) when this really is the owner. That is the fix
   *    for the leak this task exists to close: previously that call was
   *    unconditional regardless of whose context was passed in. See the T9
   *    report and `items.test.ts` for the regression test.
   */
  isOwner?: boolean
  /**
   * Days the owner published a note (`YYYY-MM-DD`), forwarded to
   * `UnlockContext`. Only meaningful when `isOwner` is true. Passed in rather
   * than read from disk, so this module and everything under it stays free of
   * `fs` and can run in a browser.
   */
  ownerNoteDays?: readonly string[]
}

/**
 * Mirrors `getCreatureState()`'s arithmetic exactly (see file header for why
 * it cannot just call that function), parameterized on `stats` so the
 * garden-asymmetry rule can be enforced by the caller.
 */
export function composeCreatureState(
  stats: GardenStats,
  github: GithubStats | null,
  options: ComposeOptions = {}
): CreatureState {
  const includeItems = options.includeItems ?? true
  const isOwner = options.isOwner ?? true

  const gardenXp = computeGardenXp(stats)
  const commitXp = computeCommitXp(github)
  const breakdown = [...gardenXp, ...commitXp]

  const totalXp = breakdown.reduce((sum, entry) => sum + entry.xp, 0)
  const { stage, nextStage, xpIntoStage, xpForNextStage, progress } =
    resolveStage(totalXp)

  let items: ItemState[] = []
  if (includeItems) {
    const ctx: UnlockContext = {
      stats,
      github,
      isOwner,
      ownerNoteDays: options.ownerNoteDays,
    }
    const applicableItems = isOwner ? ITEMS : COMMIT_ITEMS
    items = applicableItems.map((def) => ({
      def,
      unlocked: def.unlocked(ctx),
      progress: def.progress(ctx),
    }))
  }

  return {
    stage,
    nextStage,
    totalXp,
    xpIntoStage,
    xpForNextStage,
    progress,
    breakdown,
    items,
    stats,
    github,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Stage-1, zero-XP creature for when no fresh data (and no stale cache) is
 * available at all: GitHub rate-limited or unreachable, first request for
 * this handle. Never a 500, always something renderable.
 */
export function fallbackCreatureState(includeItems = false): CreatureState {
  return composeCreatureState(emptyGardenStats(), null, {
    includeItems,
    isOwner: false,
  })
}

// ---------------------------------------------------------------------------
// Repo creatures
// ---------------------------------------------------------------------------

/**
 * Derives a single repo's own `GithubStats` from a fetch that was made with
 * `gardenRepo` set to that repo's name. `github.ts`'s `gardenCommitsByDay`
 * is, by construction, the subset of a user's commits landing in whichever
 * repo `gardenRepo` named; passing the target repo as `gardenRepo` turns
 * that subset into exactly "this repo's per-day commit activity", without
 * needing a second endpoint or editing `github.ts`.
 *
 * `gardenCommitsByDay` on the RETURNED stats is always empty: the higher
 * `commit-to-garden` XP rate is reserved for commits landing in this SITE's
 * own repo (Terrarium itself), not for an arbitrary repo creature.
 * A repo creature's commits all score at the flat `commit` rate. See the T6
 * report for the "what does an item mean on a repo creature" question,
 * answered by `includeItems: false` at the call site.
 */
export function toRepoCommitStats(
  fetched: GithubStats,
  repo: string
): GithubStats {
  const commitsByDay = fetched.gardenCommitsByDay
  const totalCommits = Object.values(commitsByDay).reduce((a, b) => a + b, 0)

  return {
    login: fetched.login,
    totalCommits,
    commitsByDay,
    gardenCommitsByDay: {},
    currentStreakDays: computeCurrentStreak(commitsByDay),
    fetchedAt: fetched.fetchedAt,
  }
}

/** True when a repo-scoped fetch found zero commit activity for that repo. */
export function repoStatsAreEmpty(stats: GithubStats): boolean {
  return Object.keys(stats.commitsByDay).length === 0
}
