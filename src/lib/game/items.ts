/**
 * The unlockable items from DESIGN.md section 3.4, plus three commit-based
 * items added for non-owner creatures (T9). Each item is a pure predicate
 * plus a 0..1 progress readout for the locked-state UI.
 *
 * Every `unlocked`/`progress` function is defensive: an item that depends on
 * GitHub data returns `false` / `0` when `ctx.github` is null instead of
 * throwing.
 *
 * GARDEN_ITEMS vs COMMIT_ITEMS
 * `GARDEN_ITEMS` need a garden to mean anything (they read `ctx.stats`,
 * which is genuinely zeroed for anyone who is not the site owner, see
 * `repo-creature.ts`). `COMMIT_ITEMS` work from `ctx.github` alone, which is
 * real for any public GitHub handle. A non-owner creature is only ever
 * handed `COMMIT_ITEMS`: shipping `GARDEN_ITEMS` as permanently-locked noise
 * on a creature that can never earn them (no garden exists to earn them
 * with) is worse than not showing them at all. See `repo-creature.ts` for
 * where that split is applied.
 *
 * THE LEAK THIS FILE USED TO HAVE
 * `getActiveDays()` used to call `getAllContent()` unconditionally, reading
 * the site owner's local MDX publish dates into the Dew Vial streak
 * calculation regardless of whose `UnlockContext` was passed in. That is
 * why items were disabled entirely for non-owner creatures (see the T6
 * report). Fixed by gating that call on `ctx.isOwner`, the one field
 * `UnlockContext` was unfrozen to add. See `items.test.ts`'s "no leak" test
 * for the regression check.
 */

import { ItemDef, UnlockContext } from './types'

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Longest run of consecutive calendar days, ending today, for which
 * `days` contains a matching YYYY-MM-DD key. Used by Dew Vial.
 */
function currentStreakEndingToday(days: Set<string>): number {
  let streak = 0
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  // Cap the walk so a pathological data set can't loop forever.
  for (let i = 0; i < 3650; i++) {
    const iso = cursor.toISOString().slice(0, 10)
    if (!days.has(iso)) break
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/**
 * Longest run of consecutive calendar days anywhere in `days`, regardless
 * of whether it reaches today. Used only to give the locked-state Dew Vial
 * progress bar something meaningful to show; static content dates from a
 * past build will rarely produce a streak that reaches "today", so this
 * gives partial credit for the best run on record instead of always
 * reading 0.
 */
function longestConsecutiveRun(days: Set<string>): number {
  if (days.size === 0) return 0
  const sorted = Array.from(days)
    .map((d) => new Date(d + 'T00:00:00Z').getTime())
    .sort((a, b) => a - b)

  let best = 1
  let current = 1
  const oneDayMs = 24 * 60 * 60 * 1000
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === oneDayMs) {
      current += 1
    } else if (sorted[i] !== sorted[i - 1]) {
      current = 1
    }
    if (current > best) best = current
  }
  return best
}

/**
 * Combines note publish dates (standing in for "note edit", since this
 * codebase has no edit-history log, only a publish `date`) with GitHub
 * commit days into one set of "active" calendar days.
 *
 * `getAllContent()` reads THIS repo's local MDX files, which are the site
 * owner's garden and nobody else's. Only merge those dates in when `ctx`
 * genuinely represents the owner's own build; every other caller (a
 * stranger's handle, any repo creature) gets a set built from `ctx.github`
 * alone. This is the fix for the leak: previously this call was
 * unconditional, so a stranger's Dew Vial streak was silently padded with
 * the owner's publish history.
 */
function getActiveDays(ctx: UnlockContext): Set<string> {
  const days = new Set<string>()
  if (ctx.isOwner) {
    for (const day of ctx.ownerNoteDays ?? []) {
      if (day) days.add(day)
    }
  }
  if (ctx.github) {
    for (const day of Object.keys(ctx.github.commitsByDay)) days.add(day)
  }
  return days
}

/**
 * Same shape as `getActiveDays`, restricted to `ctx.github` only, never
 * touching `getAllContent()` at all. Used by the commit-only items so their
 * behaviour never depends on `ctx.isOwner`: a commit item must read
 * identically for the owner and for a stranger, since both are computed
 * from public GitHub data alone.
 */
function getGithubActiveDays(ctx: UnlockContext): Set<string> {
  const days = new Set<string>()
  if (ctx.github) {
    for (const day of Object.keys(ctx.github.commitsByDay)) days.add(day)
  }
  return days
}

/** Highest single-day commit count in `ctx.github`, or 0 when there is none. */
function maxCommitsInADay(ctx: UnlockContext): number {
  if (!ctx.github) return 0
  let max = 0
  for (const count of Object.values(ctx.github.commitsByDay)) {
    if (count > max) max = count
  }
  return max
}

const DEW_VIAL_TARGET_DAYS = 7
const SPORE_JAR_TARGET_NOTES = 5
const HAND_LENS_TARGET_BACKLINKS = 5
const FIELD_LEDGER_TARGET_NOTES = 25
const BRASS_COMPASS_TARGET_TAGS = 10

// Commit-based items (T9). Organic thresholds, not round marketing numbers:
// picked so they sit a little past what a casual contributor drifts into by
// accident, without being a grind.
/** A commit streak, GitHub data only (no note dates), longer than Dew Vial's 7. */
const EMBER_TRAIL_TARGET_DAYS = 11
/** A single day's commit count that reads as a genuine push, not a fluke. */
const FIELD_BURST_TARGET_COMMITS = 8
/** Cumulative commits across the 90 day fetch window. */
const SURVEY_STAKE_TARGET_COMMITS = 137

/** Items that require a garden to mean anything. Owner-only. */
export const GARDEN_ITEMS: ItemDef[] = [
  {
    id: 'spore-jar',
    name: 'Spore Jar',
    requirement: 'Publish 5 notes',
    sprite: 'spore-jar',
    unlocked: (ctx) => ctx.stats.noteCount >= SPORE_JAR_TARGET_NOTES,
    progress: (ctx) =>
      ctx.stats.noteCount >= SPORE_JAR_TARGET_NOTES
        ? 1
        : clamp01(ctx.stats.noteCount / SPORE_JAR_TARGET_NOTES),
  },
  {
    id: 'dew-vial',
    name: 'Dew Vial',
    requirement: '7 consecutive days with a commit or a note edit',
    sprite: 'dew-vial',
    unlocked: (ctx) =>
      currentStreakEndingToday(getActiveDays(ctx)) >= DEW_VIAL_TARGET_DAYS,
    progress: (ctx) => {
      const days = getActiveDays(ctx)
      if (currentStreakEndingToday(days) >= DEW_VIAL_TARGET_DAYS) return 1
      return clamp01(longestConsecutiveRun(days) / DEW_VIAL_TARGET_DAYS)
    },
  },
  {
    id: 'hand-lens',
    name: 'Hand Lens',
    requirement: 'A single note reaches 5 backlinks',
    sprite: 'hand-lens',
    unlocked: (ctx) =>
      ctx.stats.maxBacklinksOnSingleNote >= HAND_LENS_TARGET_BACKLINKS,
    progress: (ctx) =>
      ctx.stats.maxBacklinksOnSingleNote >= HAND_LENS_TARGET_BACKLINKS
        ? 1
        : clamp01(
            ctx.stats.maxBacklinksOnSingleNote / HAND_LENS_TARGET_BACKLINKS
          ),
  },
  {
    id: 'trowel',
    name: 'Trowel',
    requirement: 'Publish your first project',
    sprite: 'trowel',
    unlocked: (ctx) => ctx.stats.projectCount >= 1,
    progress: (ctx) => (ctx.stats.projectCount >= 1 ? 1 : 0),
  },
  {
    id: 'field-ledger',
    name: 'Field Ledger',
    requirement: 'Reach 25 notes',
    sprite: 'field-ledger',
    unlocked: (ctx) => ctx.stats.noteCount >= FIELD_LEDGER_TARGET_NOTES,
    progress: (ctx) =>
      ctx.stats.noteCount >= FIELD_LEDGER_TARGET_NOTES
        ? 1
        : clamp01(ctx.stats.noteCount / FIELD_LEDGER_TARGET_NOTES),
  },
  {
    id: 'brass-compass',
    name: 'Brass Compass',
    requirement: 'Use 10 distinct tags',
    sprite: 'brass-compass',
    unlocked: (ctx) => ctx.stats.tagCount >= BRASS_COMPASS_TARGET_TAGS,
    progress: (ctx) =>
      ctx.stats.tagCount >= BRASS_COMPASS_TARGET_TAGS
        ? 1
        : clamp01(ctx.stats.tagCount / BRASS_COMPASS_TARGET_TAGS),
  },
  {
    id: 'pressed-frond',
    name: 'Pressed Frond',
    requirement: 'A note reaches evergreen',
    sprite: 'pressed-frond',
    unlocked: (ctx) => ctx.stats.maturityCounts.evergreen >= 1,
    progress: (ctx) => {
      if (ctx.stats.maturityCounts.evergreen >= 1) return 1
      // Partial credit: a note sitting at budding is closer to evergreen
      // than a garden with none at all.
      return ctx.stats.maturityCounts.budding >= 1 ? 0.5 : 0
    },
  },
]

/**
 * Items that work from public GitHub commit data alone. Available to any
 * creature with a `github` fetch, owner or stranger, garden or repo. Every
 * predicate here reads `ctx.github` only, never `ctx.stats` or `ctx.isOwner`.
 */
export const COMMIT_ITEMS: ItemDef[] = [
  {
    // `ItemId` (types.ts) is frozen outside of `UnlockContext` for this task,
    // and only ever appears as `ItemDef.id`'s type, so widening it would not
    // require updating a single consumer. Left untouched anyway, per the
    // letter of the freeze; the ids below are asserted instead of adding to
    // the union. Flagged in the T9 report as a place worth revisiting.
    id: 'ember-trail',
    name: 'Ember Trail',
    requirement: `${EMBER_TRAIL_TARGET_DAYS} consecutive days with a commit`,
    sprite: 'ember-trail',
    unlocked: (ctx) =>
      currentStreakEndingToday(getGithubActiveDays(ctx)) >= EMBER_TRAIL_TARGET_DAYS,
    progress: (ctx) => {
      const days = getGithubActiveDays(ctx)
      if (currentStreakEndingToday(days) >= EMBER_TRAIL_TARGET_DAYS) return 1
      return clamp01(longestConsecutiveRun(days) / EMBER_TRAIL_TARGET_DAYS)
    },
  },
  {
    id: 'field-burst',
    name: 'Field Burst',
    requirement: `${FIELD_BURST_TARGET_COMMITS} or more commits in a single day`,
    sprite: 'field-burst',
    unlocked: (ctx) => maxCommitsInADay(ctx) >= FIELD_BURST_TARGET_COMMITS,
    progress: (ctx) =>
      maxCommitsInADay(ctx) >= FIELD_BURST_TARGET_COMMITS
        ? 1
        : clamp01(maxCommitsInADay(ctx) / FIELD_BURST_TARGET_COMMITS),
  },
  {
    id: 'survey-stake',
    name: 'Survey Stake',
    requirement: `${SURVEY_STAKE_TARGET_COMMITS} commits logged`,
    sprite: 'survey-stake',
    unlocked: (ctx) =>
      (ctx.github?.totalCommits ?? 0) >= SURVEY_STAKE_TARGET_COMMITS,
    progress: (ctx) =>
      (ctx.github?.totalCommits ?? 0) >= SURVEY_STAKE_TARGET_COMMITS
        ? 1
        : clamp01((ctx.github?.totalCommits ?? 0) / SURVEY_STAKE_TARGET_COMMITS),
  },
]

/** Every item, garden and commit. Only ever handed to the owner's own creature. */
export const ITEMS: ItemDef[] = [...GARDEN_ITEMS, ...COMMIT_ITEMS]
