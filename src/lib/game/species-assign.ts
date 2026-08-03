/**
 * Deterministic mapping from a repo's characteristics to one of
 * `SPECIES_LINES` (see `sprites/species.ts`).
 *
 * DETERMINISTIC MEANS DETERMINISTIC: nothing in this file reads `Math.random`,
 * `Date.now`, or anything else that could make the same repo resolve to a
 * different creature on a later call. A creature that changes on refresh is
 * not a collection (T19 spec). `species-assign.test.ts` asserts this by
 * calling `assignSpeciesLine` twice on the same input and requiring the same
 * result, and by calling it many times across a process to rule out any
 * hidden global mutation.
 *
 * Primary language is the most legible signal (a Rust repo and a Python repo
 * should visibly differ), so it wins whenever it maps to a known line. When
 * the language is missing or unmapped, the assignment falls back to a stable
 * hash of the repo's identity plus its other characteristics (age, size,
 * cadence), so two language-less repos still end up as different creatures
 * rather than all collapsing onto the same default line.
 */
import { SPECIES_LINES, getSpeciesLine, DEFAULT_SPECIES_LINE_ID, type SpeciesLine } from './sprites/species'

export interface RepoCharacteristics {
  owner: string
  repo: string
  /** GitHub's `language` field. Null/empty when GitHub reports none. */
  language: string | null
  /** ISO timestamp, GitHub's `created_at`. */
  createdAt: string | null
  /** ISO timestamp, GitHub's `pushed_at`. Used as a cadence/recency signal. */
  pushedAt: string | null
  /** GitHub's `size` field, in KB. */
  sizeKb: number | null
}

const LANGUAGE_TO_LINE = new Map<string, SpeciesLine>()
for (const line of SPECIES_LINES) {
  for (const lang of line.languages) {
    LANGUAGE_TO_LINE.set(lang.toLowerCase(), line)
  }
}

/**
 * FNV-1a, a small non-cryptographic hash with good distribution for short
 * strings and no dependency. Picked over `Array.prototype.reduce` char-sum
 * hashing because a straight char sum collides constantly on short repo
 * names ('ab' and 'ba' hash the same); FNV-1a does not have that problem.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // >>> 0 forces an unsigned 32-bit integer, so the result is always >= 0
  // and safe to use with `%`.
  return hash >>> 0
}

function ageBucket(createdAt: string | null): string {
  if (!createdAt) return 'age-unknown'
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return 'age-unknown'
  const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24)
  if (ageDays < 90) return 'age-new'
  if (ageDays < 365) return 'age-young'
  if (ageDays < 365 * 3) return 'age-established'
  return 'age-old'
}

function sizeBucket(sizeKb: number | null): string {
  if (sizeKb === null || !Number.isFinite(sizeKb)) return 'size-unknown'
  if (sizeKb < 500) return 'size-tiny'
  if (sizeKb < 5_000) return 'size-small'
  if (sizeKb < 50_000) return 'size-medium'
  return 'size-large'
}

/**
 * Cadence: how recently the repo was pushed to, relative to its own age.
 * Crude but deterministic and needs no extra data beyond what a repo listing
 * already carries.
 */
function cadenceBucket(createdAt: string | null, pushedAt: string | null): string {
  if (!createdAt || !pushedAt) return 'cadence-unknown'
  const created = Date.parse(createdAt)
  const pushed = Date.parse(pushedAt)
  if (Number.isNaN(created) || Number.isNaN(pushed)) return 'cadence-unknown'
  const lifespanDays = Math.max(1, (pushed - created) / (1000 * 60 * 60 * 24))
  const sinceLastPushDays = (Date.now() - pushed) / (1000 * 60 * 60 * 24)
  if (sinceLastPushDays > lifespanDays) return 'cadence-dormant'
  if (sinceLastPushDays < 14) return 'cadence-active'
  return 'cadence-steady'
}

/**
 * Resolves the fallback line (used when the language does not map to a
 * known line) by hashing the repo's full identity plus its other
 * characteristics. Deterministic: same input, same output, always.
 */
function fallbackLine(chars: RepoCharacteristics): SpeciesLine {
  const key = [
    `${chars.owner.toLowerCase()}/${chars.repo.toLowerCase()}`,
    chars.language?.toLowerCase() ?? 'no-language',
    ageBucket(chars.createdAt),
    sizeBucket(chars.sizeKb),
    cadenceBucket(chars.createdAt, chars.pushedAt),
  ].join('|')

  const hash = fnv1a(key)
  const index = hash % SPECIES_LINES.length
  return SPECIES_LINES[index]
}

/**
 * The single entry point: maps a repo's characteristics onto a species
 * line, deterministically. Language wins when it is known and mapped;
 * otherwise a stable hash of the repo's identity and remaining
 * characteristics picks among every line, so unmapped-language repos still
 * differ from one another rather than all collapsing onto `grass`.
 */
export function assignSpeciesLine(chars: RepoCharacteristics): SpeciesLine {
  const lang = chars.language?.toLowerCase().trim()
  if (lang) {
    const byLanguage = LANGUAGE_TO_LINE.get(lang)
    if (byLanguage) return byLanguage
  }
  return fallbackLine(chars)
}

/** Exposed for the extension's port of this logic to stay verifiably in sync. */
export function assignSpeciesLineId(chars: RepoCharacteristics): string {
  return assignSpeciesLine(chars).id
}

export { getSpeciesLine, DEFAULT_SPECIES_LINE_ID }

// ---------------------------------------------------------------------------
// Cluster / theme assignment (T22)
//
// A repo has a language, which is a clean, single-valued signal. A note
// cluster has no such field, so the theme has to be read out of real text:
// the tag name first (the strongest, most deliberate signal an author gives
// a body of work), then the titles and descriptions of the notes in it, then
// a hash fallback so nothing is ever empty. Reuses SPECIES_LINES exactly as
// the repo path does; no parallel species system.
// ---------------------------------------------------------------------------

export interface ClusterCharacteristics {
  /** The tag that defines the cluster, e.g. "writing", "design". */
  tag: string
  /** Titles and descriptions of the cluster's member notes, in priority
   * order they were authored. Checked only when the tag name itself does
   * not match a theme. */
  memberText: string[]
}

/**
 * Keyword -> species line, for note-shaped topics. Deliberately reuses the
 * existing `SPECIES_LINES` pool rather than inventing cluster-only species:
 * each keyword set picks the line whose existing `theme` reads closest to
 * that topic (e.g. "design" -> `bloom`, the markup/decorative line; "tools"
 * -> `steel`, the infrastructure/machinery line).
 *
 * `species.test.ts` guards `SPECIES_LINES` against a language listed twice;
 * the mirror invariant for this table (no keyword listed under two lines) is
 * asserted in `species-assign.test.ts`.
 */
const CLUSTER_THEME_KEYWORDS: Record<string, string[]> = {
  bloom: ['design', 'art', 'visual', 'aesthetic', 'aesthetics', 'ui', 'ux', 'style'],
  current: ['music', 'audio', 'sound', 'rhythm'],
  ember: ['security', 'hacking', 'privacy', 'encryption', 'hack'],
  grass: ['writing', 'journal', 'garden', 'notes', 'note'],
  bedrock: ['reading', 'books', 'book', 'research', 'knowledge'],
  psychic: ['thinking', 'philosophy', 'ideas', 'idea', 'mind', 'ai'],
  tide: ['learning', 'education', 'study', 'course'],
  steel: ['tools', 'tool', 'productivity', 'workflow', 'engineering'],
  venom: ['review', 'critique', 'opinion', 'gaming', 'game'],
}

const CLUSTER_KEYWORD_TO_LINE = new Map<string, SpeciesLine>()
for (const [lineId, keywords] of Object.entries(CLUSTER_THEME_KEYWORDS)) {
  const line = getSpeciesLine(lineId)
  for (const keyword of keywords) {
    CLUSTER_KEYWORD_TO_LINE.set(keyword, line)
  }
}

/**
 * Matches `text` against every cluster theme keyword on a word boundary
 * (so "art" does not fire on "start"), returning the first line whose
 * keyword hits. `Map` iteration order is insertion order, which is fixed by
 * the literal above, so this is deterministic across calls.
 */
function matchThemeLine(text: string): SpeciesLine | null {
  const lower = text.toLowerCase()
  for (const [keyword, line] of CLUSTER_KEYWORD_TO_LINE) {
    if (new RegExp(`\\b${keyword}\\b`).test(lower)) return line
  }
  return null
}

/**
 * Resolves the fallback line for a cluster whose tag and member text match
 * no known theme keyword, by hashing the tag name alone. Deterministic:
 * same tag, same output, always. Prefixed so a cluster tag can never
 * collide with a repo's fallback hash input in `fallbackLine` above (not
 * that the two are ever compared, but it keeps the hash spaces distinct).
 */
function clusterFallbackLine(tag: string): SpeciesLine {
  const hash = fnv1a(`cluster:${tag.toLowerCase()}`)
  const index = hash % SPECIES_LINES.length
  return SPECIES_LINES[index]
}

/**
 * The cluster equivalent of `assignSpeciesLine`: deterministic, priority
 * order tag name -> member titles/descriptions -> hash fallback. Same
 * cluster (same tag, same members) always yields the same species line.
 */
export function assignClusterSpeciesLine(chars: ClusterCharacteristics): SpeciesLine {
  const byTag = matchThemeLine(chars.tag)
  if (byTag) return byTag

  for (const text of chars.memberText) {
    const byText = matchThemeLine(text)
    if (byText) return byText
  }

  return clusterFallbackLine(chars.tag)
}

/** Exposed for the same reason `assignSpeciesLineId` is: a stable id-only surface. */
export function assignClusterSpeciesLineId(chars: ClusterCharacteristics): string {
  return assignClusterSpeciesLine(chars).id
}
