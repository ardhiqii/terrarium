/**
 * Shared contracts for the creature / XP system.
 *
 * THIS FILE IS THE INTERFACE BOUNDARY. Every other module in `src/lib/game`
 * and `src/components/game` builds against these types. Do not change a shape
 * here without updating every consumer, and do not add module-local duplicates
 * of these types elsewhere.
 *
 * See DESIGN.md sections 3 and 4 for the reasoning behind the numbers.
 */

/**
 * Note maturity. Optional in frontmatter; absent means 'seedling'.
 * Rendered as a neutral weight ramp plus a glyph, never as three colours.
 */
export type Maturity = 'seedling' | 'budding' | 'evergreen'

export const MATURITIES: readonly Maturity[] = [
  'seedling',
  'budding',
  'evergreen',
] as const

// ---------------------------------------------------------------------------
// Raw measurements
// ---------------------------------------------------------------------------

/**
 * Everything measurable about the garden, derived at build time from
 * `content.ts`, `backlinks.ts`, and `graph.ts`. Pure data, no XP math.
 */
export interface GardenStats {
  noteCount: number
  projectCount: number
  /** Word count across all body copy, frontmatter excluded. */
  totalWords: number
  /** Outgoing wikilinks that resolve to a real note. Unresolved ones score nothing. */
  resolvedWikilinks: number
  /** Total inbound edges across the graph, deduped per source/target pair. */
  backlinksReceived: number
  /** Distinct tags in use. */
  tagCount: number
  /** How many notes sit at each maturity level. */
  maturityCounts: Record<Maturity, number>
  /** Highest backlink count on any single note. Drives the Hand Lens item. */
  maxBacklinksOnSingleNote: number
  /** ISO date of the oldest published item, or null when the garden is empty. */
  firstPublishedAt: string | null
  /** ISO date of the newest published item, or null when the garden is empty. */
  lastPublishedAt: string | null
}

/**
 * GitHub contribution data, fetched at build time and cached to JSON.
 * Null everywhere when the fetch fails or no token is configured; the creature
 * must render correctly from garden data alone.
 */
export interface GithubStats {
  login: string
  totalCommits: number
  /** ISO date (YYYY-MM-DD) -> commit count on that day, across all repos. */
  commitsByDay: Record<string, number>
  /**
   * The subset of `commitsByDay` landing in this garden's own repo, which
   * score at the higher `commitToGarden` rate. Every key here must also exist
   * in `commitsByDay` with a count at least as large.
   */
  gardenCommitsByDay: Record<string, number>
  /** Consecutive days up to today with at least one commit. */
  currentStreakDays: number
  /** ISO timestamp of the fetch, used for cache staleness checks. */
  fetchedAt: string
}

// ---------------------------------------------------------------------------
// XP
// ---------------------------------------------------------------------------

export type XpSource =
  | 'note-published'
  | 'words'
  | 'wikilink'
  | 'backlink'
  | 'tag'
  | 'promoted-budding'
  | 'promoted-evergreen'
  | 'commit'
  | 'commit-garden'

/**
 * One line of the XP ledger. The UI renders these directly, so `label` is
 * user-facing copy and must follow the standing rules in DESIGN.md section 6
 * (no em-dashes).
 */
export interface XpEntry {
  source: XpSource
  /** User-facing description, e.g. "Backlinks received". */
  label: string
  /** How many times this source fired. */
  count: number
  /** XP awarded per occurrence, before any cap. */
  rate: number
  /** Total XP from this source after caps. */
  xp: number
}

/** XP rates. Single source of truth; never inline these numbers. */
export const XP_RATES = {
  notePublished: 100,
  /** Per 100 words, deliberately low so padding a note is a poor strategy. */
  perHundredWords: 10,
  resolvedWikilink: 15,
  backlinkReceived: 10,
  newTag: 25,
  promotedToBudding: 50,
  promotedToEvergreen: 150,
  commit: 5,
  commitToGarden: 10,
} as const

/** Daily XP ceiling on commits, so a scripted commit loop cannot farm the creature. */
export const COMMIT_XP_DAILY_CAP = 100

// ---------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------

export type StageId = 'sporeling' | 'mossling' | 'bracken' | 'heartwood'

export interface Stage {
  id: StageId
  /** Display name, e.g. "Mossling". */
  name: string
  /** 1-indexed position in the line. */
  index: number
  /** Cumulative XP at which this stage begins. */
  threshold: number
  /** One sentence on what reaching this stage says about the garden. */
  blurb: string
}

/**
 * The evolution line. Ordered by threshold ascending; `resolveStage` relies on
 * that ordering.
 */
export const STAGES: readonly Stage[] = [
  {
    id: 'sporeling',
    name: 'Sporeling',
    index: 1,
    threshold: 0,
    blurb: 'The garden exists. A few scattered notes.',
  },
  {
    id: 'mossling',
    name: 'Mossling',
    index: 2,
    threshold: 1500,
    blurb: 'Notes are accumulating and starting to link.',
  },
  {
    id: 'bracken',
    name: 'Bracken',
    index: 3,
    threshold: 5000,
    blurb: 'A real body of work with dense interconnection.',
  },
  {
    id: 'heartwood',
    name: 'Heartwood',
    index: 4,
    threshold: 12000,
    blurb: 'An established garden.',
  },
] as const

// ---------------------------------------------------------------------------
// Variants (T30)
// ---------------------------------------------------------------------------

/**
 * A creature's shape trait, derived from `GardenStats` (and, for `steady`,
 * `GithubStats`) rather than from XP or stage. `null` (no variant) is the
 * common case by design; see `variants.ts` for thresholds and precedence.
 */
export type Variant = 'woven' | 'steady' | 'deep' | 'broad'

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * Garden items need real garden stats and only apply to the site owner.
 * Commit items derive from GitHub data alone, so they work for any handle and
 * for repo creatures. See `items.ts` for the split.
 */
export type ItemId =
  // Garden items
  | 'spore-jar'
  | 'dew-vial'
  | 'hand-lens'
  | 'trowel'
  | 'field-ledger'
  | 'brass-compass'
  | 'pressed-frond'
  // Commit items
  | 'ember-trail'
  | 'field-burst'
  | 'survey-stake'

/** Everything an unlock predicate is allowed to look at. */
export interface UnlockContext {
  stats: GardenStats
  github: GithubStats | null
  /**
   * True only when this context represents the site owner's own build-time
   * render. Scopes any predicate that would otherwise need to read local
   * garden data (e.g. note publish dates) not already captured in `stats`:
   * a stranger's or a repo's `UnlockContext` must always pass `false` here,
   * so a predicate has an explicit signal instead of inferring ownership
   * from `stats` happening to be non-zero. This is the fix for the bug
   * where `items.ts` read the owner's local content unconditionally,
   * regardless of whose context was passed in.
   */
  isOwner: boolean
  /**
   * Calendar days (`YYYY-MM-DD`) on which the OWNER published a note, used by
   * the Dew Vial streak.
   *
   * Passed in rather than read from disk inside `items.ts`. That module used to
   * import `../content` directly, which had two problems: it was a hidden
   * dependency that let the owner's history leak into a stranger's context, and
   * it dragged `fs` into any browser bundle importing the item system, which
   * broke the client-side garden entirely. Explicit data in, no ambient reads.
   *
   * Omitted or empty for every non-owner context.
   */
  ownerNoteDays?: readonly string[]
}

export interface ItemDef {
  id: ItemId
  name: string
  /** User-facing unlock condition, e.g. "Publish 5 notes". */
  requirement: string
  /** Sprite id in the sprite registry. */
  sprite: string
  unlocked(ctx: UnlockContext): boolean
  /**
   * Progress toward the unlock as 0..1, for the locked-state UI.
   * Return 1 whenever `unlocked` returns true.
   */
  progress(ctx: UnlockContext): number
}

export interface ItemState {
  def: ItemDef
  unlocked: boolean
  progress: number
}

// ---------------------------------------------------------------------------
// Top-level state
// ---------------------------------------------------------------------------

/**
 * The single object every creature surface renders from. Computed once at
 * build time by `getCreatureState()`.
 */
export interface CreatureState {
  stage: Stage
  /** The stage after `stage`, or null when the line is complete. */
  nextStage: Stage | null
  totalXp: number
  /** XP earned since entering the current stage. */
  xpIntoStage: number
  /** XP span of the current stage, or null at max stage. */
  xpForNextStage: number | null
  /** 0..1 progress through the current stage. Exactly 1 at max stage. */
  progress: number
  breakdown: XpEntry[]
  items: ItemState[]
  stats: GardenStats
  github: GithubStats | null
  /** ISO timestamp of the build that produced this state. */
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Sprites
// ---------------------------------------------------------------------------

/**
 * Pixel art stored as data, not as image files, so it stays diffable,
 * themeable, and renderable to both DOM and SVG from one source.
 *
 * Each frame is an array of `height` strings, each exactly `width` characters
 * long. Every character indexes into `palette`. Index 0 is always transparent.
 *
 *   palette: ['transparent', '#4a7c59', '#7cbf8e']
 *   frames: [[ '0110', '1221', '1221', '0110' ]]
 *
 * Characters are 0-9 then a-z, giving a 36 colour ceiling per sprite, which is
 * far more than pixel art at this size needs.
 */
export interface SpriteData {
  id: string
  width: number
  height: number
  /** Index 0 MUST be the string 'transparent'. */
  palette: string[]
  /** One or more frames. Frame 0 is the resting pose. */
  frames: string[][]
  /** Milliseconds per frame for idle animation. Ignored for single-frame sprites. */
  frameDurationMs?: number
}

/** Canonical sprite grid. Creatures and items both use it. */
export const SPRITE_SIZE = 32

/**
 * Integer scale factors only. Fractional scaling destroys pixel art, so the
 * renderer must never accept a percentage width.
 */
export type SpriteScale = 1 | 2 | 3 | 4
