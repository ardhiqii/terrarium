/**
 * Shared user-facing sentences that would otherwise be repeated across surfaces.
 *
 * WHY THIS EXISTS (`DESIGN.md` §7, rule R3 "say it once"): the same reassurances
 * used to be written out separately on several pages and had already started to
 * drift ("granted when you first arrive" vs "another every day you come back").
 * A sentence that appears in more than one place lives here, so it is written
 * once and reads the same everywhere.
 *
 * Pure strings only: client components import this, so it must never reach a
 * Node built-in (see `client-bundle-safety.test.ts`).
 */

export const COPY = {
  /** How new companions are obtained. */
  dailyCompanion: 'A new companion arrives each day you visit.',
  /** The privacy model for a mounted notes folder. */
  localOnly: 'Reads a folder in this tab. Nothing uploads.',
  /** The guarantee of the condition layer (`PRODUCT.md` §12). */
  conditionIsRecoverable:
    'Condition changes daily and can always recover. It never removes XP, a stage, or a companion.',
} as const

/**
 * `/guide` sections that other surfaces may link to. Only ids that exist on the
 * guide page belong here; a test checks each one against the page source.
 */
export const GUIDE_ANCHORS = {
  howXpWorks: 'how-xp-works',
  stages: 'the-four-stages',
  companions: 'companions',
  items: 'items',
  xpSources: 'where-xp-comes-from',
  condition: 'condition',
  githubSync: 'github-sync',
  privacy: 'privacy',
  leaderboard: 'leaderboard',
} as const

export type GuideAnchor = (typeof GUIDE_ANCHORS)[keyof typeof GUIDE_ANCHORS]
