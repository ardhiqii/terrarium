/**
 * A scan's memory, small enough to persist and free of note content.
 *
 * WHY THIS EXISTS: the scan runtime kept its "what did the folder look like last
 * time" state in a `useRef`, which is memory only. Closing the tab threw it away,
 * so the next visit saw every file as new, treated the scan as a first
 * observation, re-baselined, and awarded nothing. A user who wrote in Obsidian
 * daily and opened the site occasionally earned XP for almost none of it.
 *
 * WHY A SUMMARY RATHER THAN THE FILES: the delta a scan needs is
 *   - did this path exist before, and
 *   - is its content the same
 * and both are answerable from a hash plus a word count. Storing the full text in
 * `localStorage` would mean a second copy of the vault leaving the file system,
 * which PRODUCT.md section 4.2 rules out. `hash` and `words` are derived numbers;
 * they can say a note changed but nothing about what it now says.
 *
 * The hash is the same FNV-1a the event ids already use, so a summary and the
 * events derived from it stay consistent by construction.
 */

import type { Maturity } from './types'

/** What one note looked like at a scan, with no readable content. */
export interface MarkdownFileSummary {
  /** Path within the folder, as the scan saw it. */
  path: string
  /** FNV-1a of the content, so "did it change" is answerable without the text. */
  hash: string
  /** Body word count, so a `new-words` delta can be recomputed. */
  words: number
  /** How many [[wikilinks]] it contained, for the link delta. */
  links: number
  /**
   * Lowercased link targets. Kept because "is this link newly resolved" is a set
   * difference, not a count, so a count alone cannot reconstruct it. A link
   * target is a note title the user chose, not note content.
   */
  linkTargets: readonly string[]
  /** The file's own mtime, when the platform reported one. */
  modifiedAt: string
  /**
   * The note's maturity as that scan saw it.
   *
   * WHY IT IS HERE: this is what makes "did this note change maturity" answerable at all.
   * Before it, the only record of maturity was the CURRENT snapshot, so promotions were
   * recomputed from what a note is now rather than replayed from what it was (see the note
   * in `xp.ts`). A downgrade therefore erased its own XP with no trace it was ever awarded.
   *
   * Allowed under PRODUCT.md 4.2: maturity is a label the user writes in frontmatter, from a
   * fixed three-value vocabulary -- the same class of data as `linkTargets`, which is kept
   * for the same reason (a side-by-side comparison needs the value; a count cannot rebuild
   * it). It says nothing about what the note says.
   *
   * OPTIONAL ON PURPOSE. Summaries written before this field existed have no maturity, and
   * that absence means "not observed", NOT "seedling". Treating it as `seedling` would emit
   * a promotion for every already-evergreen note on the first scan after deploying this.
   */
  maturity?: Maturity
}

/** Every summary for one mounted folder. */
export interface MarkdownScanSummary {
  sourceId: string
  /** ISO timestamp of the scan that produced this. */
  observedAt: string
  files: readonly MarkdownFileSummary[]
}

/**
 * The same FNV-1a used for event ids in `markdown-events.ts`.
 *
 * Duplicated deliberately rather than imported: that module is about producing
 * events, this one is about what survives a reload, and a shared helper would
 * make one depend on the other for no gain. The two must agree, so if the hash
 * ever changes it has to change in both places, and the test here pins the value.
 */
export function summaryHash(content: string): string {
  let result = 2166136261
  for (let index = 0; index < content.length; index += 1) {
    result ^= content.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16)
}

/** Body words, frontmatter excluded, matching `wordCount` in `markdown-events.ts`. */
export function summaryWordCount(content: string): number {
  return content
    .replace(/^---[\s\S]*?---\s*/u, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length
}

/**
 * The note's maturity, read from its own frontmatter. Absent means `seedling`, matching the
 * frontmatter contract in `types.ts`.
 *
 * Duplicated in `markdown-events.ts` for the same reason `hash` and `wordCount` are: this
 * module is about what survives a reload, that one is about producing events, and a shared
 * helper would couple the two for no gain. They MUST agree, so the test pins them together.
 */
export function summaryMaturity(content: string): Maturity {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)
  if (!front) return 'seedling'
  const line = /^maturity:\s*(.+)$/imu.exec(front[1])
  if (!line) return 'seedling'
  const value = line[1].trim().replace(/^["']|["']$/gu, '').toLowerCase()
  return value === 'budding' || value === 'evergreen' ? value : 'seedling'
}

/** Lowercased `[[wikilink]]` targets, matching `links` in `markdown-events.ts`. */
export function summaryLinkTargets(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/gu)]
    .map((match) => match[1].trim().toLowerCase())
    .filter(Boolean)
}

export interface SummarizableFile {
  path: string
  content: string
  modifiedAt: string
}

/** Reduce what a scan read into what is worth keeping. */
export function summarizeScanFiles(
  files: readonly SummarizableFile[],
): MarkdownFileSummary[] {
  return files.map((file) => {
    const linkTargets = [...new Set(summaryLinkTargets(file.content))]
    return {
      path: file.path,
      hash: summaryHash(file.content),
      words: summaryWordCount(file.content),
      links: linkTargets.length,
      linkTargets,
      modifiedAt: file.modifiedAt,
      // Recorded so the NEXT scan can tell whether it changed. A first observation is not a
      // promotion, which is why the diff only compares two OBSERVED values.
      maturity: summaryMaturity(file.content),
    }
  })
}

const MAX_SUMMARIES = 8

/** In-memory store, for tests and for a caller that has no browser. */
export class InMemoryScanSummaryStore {
  private readonly entries = new Map<string, string>()

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value)
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }
}

export interface ScanSummaryStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const SCAN_SUMMARY_STORAGE_KEY = 'terrarium:markdown-scan-summaries'

/**
 * Which folder a summary belongs to, inside the one storage key.
 *
 * Keyed by the source id rather than by the folder NAME alone, so two folders
 * that happen to share a name (which is how this app identifies a folder at all)
 * cannot silently adopt each other's memory.
 */
function entryKey(sourceId: string): string {
  return sourceId
}

/**
 * Read every stored summary. Returns an empty record on any malformed value
 * rather than throwing: a corrupt summary must cost a re-baseline, never a
 * broken page.
 */
export function loadScanSummaries(
  store: ScanSummaryStore,
): Record<string, MarkdownScanSummary> {
  try {
    const raw = store.getItem(SCAN_SUMMARY_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const out: Record<string, MarkdownScanSummary> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const summary = parseSummary(value)
      if (summary) out[key] = summary
    }
    return out
  } catch {
    return {}
  }
}

function parseSummary(value: unknown): MarkdownScanSummary | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.sourceId !== 'string' || !record.sourceId) return null
  if (typeof record.observedAt !== 'string' || !record.observedAt) return null
  if (!Array.isArray(record.files)) return null

  const files: MarkdownFileSummary[] = []
  for (const entry of record.files) {
    if (!entry || typeof entry !== 'object') return null
    const file = entry as Record<string, unknown>
    if (typeof file.path !== 'string' || !file.path) return null
    if (typeof file.hash !== 'string' || !file.hash) return null
    if (typeof file.words !== 'number' || !Number.isFinite(file.words)) return null
    if (typeof file.links !== 'number' || !Number.isFinite(file.links)) return null
    if (typeof file.modifiedAt !== 'string' || !file.modifiedAt) return null
    const linkTargets = Array.isArray(file.linkTargets)
      ? file.linkTargets.filter((target): target is string => typeof target === 'string')
      : []
    // Maturity is read OPTIONALLY, and a missing or unrecognised value means "not observed"
    // -- never `seedling`. Dropping the summary here (the `return null` style used for a
    // malformed path or hash) would re-baseline the whole vault and re-award `new-note` for
    // every note, which is precisely the failure this optional field exists to avoid.
    const maturity: Maturity | undefined =
      file.maturity === 'seedling' || file.maturity === 'budding' || file.maturity === 'evergreen'
        ? file.maturity
        : undefined

    files.push({
      path: file.path,
      hash: file.hash,
      words: file.words,
      links: file.links,
      linkTargets,
      modifiedAt: file.modifiedAt,
      ...(maturity ? { maturity } : {}),
    })
  }

  return { sourceId: record.sourceId, observedAt: record.observedAt, files }
}

/**
 * Persist one folder's summary, evicting the least recently observed folders so
 * a user with many mounted vaults cannot fill the quota. Silent on failure: a
 * full or unavailable store must not break a scan, it only costs the memory.
 */
export function saveScanSummary(
  store: ScanSummaryStore,
  summary: MarkdownScanSummary,
): void {
  try {
    const all = loadScanSummaries(store)
    all[entryKey(summary.sourceId)] = summary

    const ordered = Object.entries(all).sort((left, right) =>
      left[1].observedAt.localeCompare(right[1].observedAt),
    )
    const kept = Object.fromEntries(ordered.slice(-MAX_SUMMARIES))
    store.setItem(SCAN_SUMMARY_STORAGE_KEY, JSON.stringify(kept))
  } catch {
    // A summary is an optimisation. Losing it costs a re-baseline, not a scan.
  }
}

export function clearScanSummary(store: ScanSummaryStore, sourceId: string): void {
  try {
    const all = loadScanSummaries(store)
    delete all[entryKey(sourceId)]
    if (Object.keys(all).length === 0) store.removeItem(SCAN_SUMMARY_STORAGE_KEY)
    else store.setItem(SCAN_SUMMARY_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Nothing to recover from.
  }
}
