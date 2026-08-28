/**
 * Creature variant traits (T30). The sprite's appearance does not change;
 * the SHAPE of the garden shows up as a name suffix instead, `var. woven`
 * in the botanical sense (docs/DESIGN.md 3.5, docs/archive/tasks/T30.md).
 *
 * PURE. No `fs`, no network. `SpecimenPlate.tsx`, `CollectionGrid.tsx`, and
 * `ProfileSpecimen.tsx` are all reached from client bundles one hop or more
 * downstream, and the browser extension's `core.js` ports this exact logic
 * by hand (it cannot import across the `src/` boundary), so
 * `client-bundle-safety.test.ts` enforces the no-`fs` rule here the same way
 * it does for `stats-from-items.ts` and `streak.ts`.
 *
 * RATIOS, NOT COUNTS. Every threshold below divides by `entryCount` (notes
 * plus projects), never compares a raw total. That is what lets a nine-item
 * garden and a nine-hundred-item garden both qualify for the same variant:
 * the shape of the work, not its volume. A raw-count threshold would just be
 * a second XP bar wearing a costume.
 *
 * MOST GARDENS EARN NONE. Every threshold here was checked against this
 * repo's own real numbers before being picked (see the T30 report for the
 * actual figures): 9 entries, 23 resolved wikilinks (2.6/entry), 15 tags
 * (1.7/entry), 2,577 words (286/entry), zero evergreen notes, no GitHub
 * streak data available locally. That is a reasonably well-tended small
 * garden, cross-linked and diversely tagged by the standards of a personal
 * site -- and it clears none of the four thresholds below. That miss is the
 * point: a threshold tuned to the garden that ships alongside it would
 * trivially fire for nearly everyone else too.
 */
import { GardenStats, GithubStats, Variant } from './types'

/**
 * Total content items a `GardenStats` describes. All four ratios below use
 * this as their denominator because `resolvedWikilinks`, `tagCount`, and
 * `totalWords` in `GardenStats` are themselves summed across notes AND
 * projects (see `stats-from-items.ts`); dividing by `noteCount` alone would
 * quietly under-count the denominator for any garden with projects.
 */
function entryCount(stats: GardenStats): number {
  return stats.noteCount + stats.projectCount
}

// ---------------------------------------------------------------------------
// woven: densely interconnected
// ---------------------------------------------------------------------------

/** Below this many entries, a single lucky link inflates the ratio wildly. */
export const WOVEN_MIN_ENTRIES = 6
/** Resolved wikilinks per entry. The real garden sits at ~2.6; this asks for more. */
export const WOVEN_LINKS_PER_ENTRY = 3

export function isWoven(stats: GardenStats): boolean {
  const entries = entryCount(stats)
  if (entries < WOVEN_MIN_ENTRIES) return false
  return stats.resolvedWikilinks / entries >= WOVEN_LINKS_PER_ENTRY
}

// ---------------------------------------------------------------------------
// steady: consistent over time
// ---------------------------------------------------------------------------

/**
 * Three unbroken weeks of commits. `GardenStats` has no daily-granularity
 * writing log (only `firstPublishedAt`/`lastPublishedAt`), so this reads
 * `GithubStats.currentStreakDays`, which already carries exactly the
 * "long unbroken streak" signal the design calls for -- real for the owner's
 * own commits and, just as meaningfully, for a single repo companion's own
 * commit history (see `repo-creature.ts`'s `toRepoCommitStats`).
 */
export const STEADY_STREAK_DAYS = 21

export function isSteady(github: GithubStats | null): boolean {
  if (!github) return false
  return github.currentStreakDays >= STEADY_STREAK_DAYS
}

// ---------------------------------------------------------------------------
// deep: depth over breadth
// ---------------------------------------------------------------------------

/** Below this, "few notes" is just "no notes yet." */
export const DEEP_MIN_ENTRIES = 3
// There is deliberately NO upper bound on entries.
//
// An earlier version capped this at 15, reasoning that a larger garden "reads
// as broad, not deep". That was wrong twice over. A garden of sixty notes
// averaging nine hundred words each, mostly evergreen, is the deepest thing
// this system can describe, and it would have earned nothing. And it made
// `deep` the only variant you could LOSE by writing more, which is backwards
// for a product whose whole premise is that tending the garden is good.
//
// The overlap it was guarding against is already handled: `broad` has its own
// independent ratio test, and precedence resolves anything qualifying for both.
/** Words per entry. The real garden sits at ~286; this asks for more than double. */
export const DEEP_WORDS_PER_ENTRY = 600
/** Fraction of entries that must have reached evergreen maturity. */
export const DEEP_EVERGREEN_RATIO = 0.5

export function isDeep(stats: GardenStats): boolean {
  const entries = entryCount(stats)
  if (entries < DEEP_MIN_ENTRIES) return false
  if (stats.totalWords / entries < DEEP_WORDS_PER_ENTRY) return false
  return stats.maturityCounts.evergreen / entries >= DEEP_EVERGREEN_RATIO
}

// ---------------------------------------------------------------------------
// broad: wide-ranging
// ---------------------------------------------------------------------------

/** Absolute floor so a 3-tag, 1-entry garden can't win on ratio alone. */
export const BROAD_MIN_TAGS = 8
/** Tags per entry. The real garden sits at ~1.7; this asks for well past it. */
export const BROAD_TAGS_PER_ENTRY = 2.5

/**
 * Split out from `isBroad` so `ProfileSpecimen.tsx` can check the one
 * variant that survives the synced-profile schema (see that file's comment)
 * without needing a full `GardenStats`.
 */
export function isBroadRatio(entries: number, tagCount: number): boolean {
  if (entries <= 0) return false
  if (tagCount < BROAD_MIN_TAGS) return false
  return tagCount / entries >= BROAD_TAGS_PER_ENTRY
}

export function isBroad(stats: GardenStats): boolean {
  return isBroadRatio(entryCount(stats), stats.tagCount)
}

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

/**
 * At most one variant per creature, chosen deterministically when more than
 * one condition fires. Order, most to least specific:
 *
 *   deep > woven > broad > steady
 *
 * Ranked by how many independent conditions each predicate requires
 * simultaneously. A signal that only fires under more constraints is harder
 * to satisfy by accident, so it is the more informative one when it does
 * fire, and it should win rather than being silently swallowed by a looser
 * variant that also happens to be true:
 *
 *   - `deep`   3 conditions at once (entry count in a narrow band AND high
 *              words/entry AND a majority evergreen). The hardest to
 *              satisfy without genuinely being a slow, revisited garden.
 *   - `woven`  2 conditions (a minimum entry count AND a high link ratio).
 *              Ranked above `broad` because link density is the signal
 *              `DESIGN.md`'s whole XP system is built around -- direct
 *              evidence notes reference each other -- while tag breadth
 *              is comparatively easy to inflate (tagging one note ten
 *              different ways costs nothing).
 *   - `broad`  2 conditions (a minimum tag count AND a high tag ratio).
 *   - `steady` 1 condition (a streak length), and the only one that says
 *              nothing about the shape of the writing itself -- it is a
 *              calendar fact, not a content fact -- so it yields to any of
 *              the three content-shape variants above it.
 */
export function resolveVariant(
  stats: GardenStats,
  github: GithubStats | null
): Variant | null {
  if (isDeep(stats)) return 'deep'
  if (isWoven(stats)) return 'woven'
  if (isBroad(stats)) return 'broad'
  if (isSteady(github)) return 'steady'
  return null
}

// ---------------------------------------------------------------------------
// Guide copy
// ---------------------------------------------------------------------------

export interface VariantDef {
  id: Variant
  /** Rendered form, e.g. "var. woven". */
  label: string
  /** One sentence on what earning this says about the garden. */
  blurb: string
  /** User-facing threshold, built from the constants above so `/guide` can
   *  never drift out of sync with the code that actually evaluates it. */
  requirement: string
}

export const VARIANT_DEFS: readonly VariantDef[] = [
  {
    id: 'woven',
    label: 'var. woven',
    blurb:
      'Densely interconnected: notes and projects reference each other far more than a typical garden does.',
    requirement: `At least ${WOVEN_LINKS_PER_ENTRY} resolved wikilinks per note or project, across at least ${WOVEN_MIN_ENTRIES} entries.`,
  },
  {
    id: 'deep',
    label: 'var. deep',
    blurb:
      'Depth over breadth: a small, unhurried garden where most of what exists has been revisited to evergreen.',
    requirement: `${DEEP_MIN_ENTRIES}+ entries, averaging ${DEEP_WORDS_PER_ENTRY}+ words each, with at least ${Math.round(DEEP_EVERGREEN_RATIO * 100)}% reaching evergreen.`,
  },
  {
    id: 'broad',
    label: 'var. broad',
    blurb:
      'Wide-ranging: a tag vocabulary that grows faster than the entry count, evidence of range rather than repetition.',
    requirement: `At least ${BROAD_MIN_TAGS} distinct tags, averaging ${BROAD_TAGS_PER_ENTRY}+ tags per entry.`,
  },
  {
    id: 'steady',
    label: 'var. steady',
    blurb: 'Consistent over time: a long unbroken streak of commits, with no gap.',
    requirement: `A current streak of ${STEADY_STREAK_DAYS}+ consecutive days with a commit.`,
  },
] as const
