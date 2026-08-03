/**
 * Pure engine behind `getGardenStats()` (stats.ts). Same measurement logic,
 * over an explicit item array instead of a fresh `fs` read, so the exact
 * same numbers come out whether the items were read from this repo's
 * `content/` directory at build time or from a folder connected in the
 * browser via the File System Access API (T23, `ConnectGarden.tsx`).
 *
 * `stats.ts` is now a thin wrapper: read disk, build `ContentItem[]`, call
 * `getGardenStatsFrom`. This file has no dependency on `fs`, `../content`, or
 * `../backlinks`, so it is safe to import from client code.
 */
import { extractWikilinks, slugify } from '../utils'
import { ContentItem, ContentMeta } from '../types'
import { GardenStats, Maturity, MATURITIES } from './types'

/**
 * Word count for a body of MDX text. Mirrors `stats.ts`'s counter exactly
 * (kept as a separate copy, same as `clusters.ts` already does, so this file
 * has no private dependency on `stats.ts` internals).
 */
function countWords(body: string): number {
  const trimmed = body.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
}

/** Builds a title/slug -> slug lookup for resolving `[[wikilinks]]`. */
function buildTitleSlugMap(items: ContentMeta[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    map.set(item.title.toLowerCase(), item.slug)
    map.set(item.slug.toLowerCase(), item.slug)
  }
  return map
}

/** Resolves a `[[wikilink]]` target against the title/slug map. */
function resolvesToRealNote(target: string, map: Map<string, string>): boolean {
  if (!target) return false
  return map.has(target.toLowerCase()) || map.has(slugify(target).toLowerCase())
}

function emptyMaturityCounts(): Record<Maturity, number> {
  const counts = {} as Record<Maturity, number>
  for (const m of MATURITIES) counts[m] = 0
  return counts
}

/**
 * Pure equivalent of `backlinks.ts`'s `buildBacklinksMap()`, sourced from an
 * explicit item array instead of a disk read. Mirrors that function's
 * algorithm exactly (title/slug index, first-writer-wins dedup by source
 * slug) so a browser-computed garden and a disk-read one produce identical
 * backlink counts for the same content. Used as the default when a caller
 * (any browser caller; `stats.ts`'s own wrapper always passes the real
 * on-disk map explicitly) does not supply one.
 */
export function buildBacklinksMapFromItems(
  items: ContentItem[]
): Map<string, ContentMeta[]> {
  const titleToFile = new Map<string, { slug: string; collection: string }>()
  for (const item of items) {
    titleToFile.set(item.title.toLowerCase(), { slug: item.slug, collection: item.collection })
    titleToFile.set(item.slug.toLowerCase(), { slug: item.slug, collection: item.collection })
  }

  const backlinks = new Map<string, ContentMeta[]>()

  for (const item of items) {
    const linkedTitles = extractWikilinks(item.content)
    for (const linkedTitle of linkedTitles) {
      const key = linkedTitle.toLowerCase()
      const slugKey = slugify(linkedTitle).toLowerCase()

      const target = titleToFile.get(key) ?? titleToFile.get(slugKey)
      if (!target) continue

      const targetKey = target.slug
      if (!backlinks.has(targetKey)) backlinks.set(targetKey, [])

      const existing = backlinks.get(targetKey)!
      const alreadyAdded = existing.some((e) => e.slug === item.slug)
      if (!alreadyAdded) {
        existing.push({
          title: item.title,
          slug: item.slug,
          collection: item.collection,
          href: `/${item.collection}/${item.slug}`,
          date: '',
          description: '',
          tags: [],
          type: item.collection === 'notes' ? 'note' : 'project',
        })
      }
    }
  }

  return backlinks
}

/**
 * Pure stats over an item array. Contains ALL of the measurement logic that
 * used to live directly in `getGardenStats()`.
 *
 * `backlinksMap` is an optional second parameter, not part of the one-arg
 * signature `tasks/T23.md` sketches, added for one reason: `stats.ts`'s
 * `getGardenStats()` wrapper must keep calling the real, disk-reading
 * `buildBacklinksMap()` from `../backlinks` so the existing mocked test
 * suite (`stats.test.ts`, which mocks `../backlinks` directly and asserts on
 * its injected map) keeps passing UNMODIFIED. When the caller does not pass
 * one -- every browser caller, which has no `../backlinks` to call -- this
 * builds one purely from `items` via `buildBacklinksMapFromItems` above.
 */
export function getGardenStatsFrom(
  items: ContentItem[],
  backlinksMap: Map<string, ContentMeta[]> = buildBacklinksMapFromItems(items)
): GardenStats {
  const noteCount = items.filter((item) => item.collection === 'notes').length
  const projectCount = items.filter((item) => item.collection === 'projects').length

  const titleSlugMap = buildTitleSlugMap(items)

  let totalWords = 0
  let resolvedWikilinks = 0
  const maturityCounts = emptyMaturityCounts()
  const tagSet = new Set<string>()
  let firstPublishedAt: string | null = null
  let lastPublishedAt: string | null = null

  for (const item of items) {
    const body = item.content ?? ''
    totalWords += countWords(body)

    for (const rawLink of extractWikilinks(body)) {
      if (resolvesToRealNote(rawLink, titleSlugMap)) resolvedWikilinks += 1
    }

    const maturity: Maturity = item.maturity ?? 'seedling'
    maturityCounts[maturity] += 1

    for (const tag of item.tags) tagSet.add(tag)

    if (item.date) {
      const t = new Date(item.date).getTime()
      if (!Number.isNaN(t)) {
        if (firstPublishedAt === null || t < new Date(firstPublishedAt).getTime()) {
          firstPublishedAt = item.date
        }
        if (lastPublishedAt === null || t > new Date(lastPublishedAt).getTime()) {
          lastPublishedAt = item.date
        }
      }
    }
  }

  let backlinksReceived = 0
  let maxBacklinksOnSingleNote = 0
  for (const sources of backlinksMap.values()) {
    backlinksReceived += sources.length
    if (sources.length > maxBacklinksOnSingleNote) {
      maxBacklinksOnSingleNote = sources.length
    }
  }

  return {
    noteCount,
    projectCount,
    totalWords,
    resolvedWikilinks,
    backlinksReceived,
    tagCount: tagSet.size,
    maturityCounts,
    maxBacklinksOnSingleNote,
    firstPublishedAt,
    lastPublishedAt,
  }
}
