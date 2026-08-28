/**
 * Cluster detection, with no `fs` dependency, so it can run in a browser.
 *
 * This file exists for the same reason `stats-from-items.ts` does. `clusters.ts`
 * imports `../backlinks`, which requires `fs` at module scope, so ANY client
 * component importing from `clusters.ts` drags `fs` into the browser bundle and
 * the page 500s. Splitting the pure half out is what keeps the browser garden
 * (T23) working: `clusters.ts` is now only the disk-reading wrapper.
 *
 * Rule being implemented: companions come from bodies of work, XP from
 * activity. A tag with `CLUSTER_THRESHOLD` or more notes is a body of work. A
 * tag below it is a seed, which already earned its notes' XP through the main
 * garden creature and simply does not appear here.
 */

import { extractWikilinks, slugify } from '../utils'
import { composeCreatureState } from './repo-creature'
import { assignClusterSpeciesLine } from './species-assign'
import { buildBacklinksMapFromItems } from './stats-from-items'
import { ContentItem, ContentMeta } from '../types'
import { CreatureState, GardenStats, Maturity, MATURITIES } from './types'
import type { SpeciesLine } from './sprites/species'

/** A tag with at least this many notes is a body of work, not a scattering. */
export const CLUSTER_THRESHOLD = 5

export interface Cluster {
  tag: string
  members: ContentMeta[]
  speciesLine: SpeciesLine
  /** Built from the cluster's OWN stats via the shared compose pipeline, so
   * `state.totalXp` / `state.stage` already reflect the cluster's work. */
  state: CreatureState
  /** Derived from member count, never stored: a cluster sitting exactly at the
   * threshold must have just crossed it. */
  isNew: boolean
}

function emptyMaturityCounts(): Record<Maturity, number> {
  const counts = {} as Record<Maturity, number>
  for (const m of MATURITIES) counts[m] = 0
  return counts
}

/** Mirrors `stats.ts`'s word counter exactly; kept local so this file has no
 * private dependency on `stats.ts` internals. */
function countWords(body: string): number {
  const trimmed = body.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
}

function buildTitleSlugMap(items: ContentMeta[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    map.set(item.title.toLowerCase(), item.slug)
    map.set(item.slug.toLowerCase(), item.slug)
  }
  return map
}

function resolvesToRealNote(target: string, map: Map<string, string>): boolean {
  if (!target) return false
  return map.has(target.toLowerCase()) || map.has(slugify(target).toLowerCase())
}

/**
 * `GardenStats` scoped to just this cluster's members.
 *
 * - `totalWords` / `resolvedWikilinks`: only the cluster's own notes count.
 * - `backlinksReceived` / `maxBacklinksOnSingleNote`: backlinks landing ON a
 *   cluster member, from anywhere in the garden, since a backlink is credit
 *   received by that note regardless of who linked it.
 * - `tagCount` / `maturityCounts`: computed from the cluster's own notes.
 */
function computeClusterStatsFrom(
  members: ContentItem[],
  allItems: ContentItem[],
  backlinksMap: Map<string, ContentMeta[]>
): GardenStats {
  const titleSlugMap = buildTitleSlugMap(allItems)

  let noteCount = 0
  let projectCount = 0
  let totalWords = 0
  let resolvedWikilinks = 0
  const maturityCounts = emptyMaturityCounts()
  const tagSet = new Set<string>()
  let firstPublishedAt: string | null = null
  let lastPublishedAt: string | null = null

  for (const member of members) {
    if (member.collection === 'notes') noteCount += 1
    else if (member.collection === 'projects') projectCount += 1

    const body = member.content ?? ''
    totalWords += countWords(body)

    for (const rawLink of extractWikilinks(body)) {
      if (resolvesToRealNote(rawLink, titleSlugMap)) resolvedWikilinks += 1
    }

    const maturity: Maturity = member.maturity ?? 'seedling'
    maturityCounts[maturity] += 1

    for (const tag of member.tags) tagSet.add(tag)

    if (member.date) {
      const t = new Date(member.date).getTime()
      if (!Number.isNaN(t)) {
        if (firstPublishedAt === null || t < new Date(firstPublishedAt).getTime()) {
          firstPublishedAt = member.date
        }
        if (lastPublishedAt === null || t > new Date(lastPublishedAt).getTime()) {
          lastPublishedAt = member.date
        }
      }
    }
  }

  let backlinksReceived = 0
  let maxBacklinksOnSingleNote = 0
  for (const member of members) {
    const sources = backlinksMap.get(member.slug) ?? []
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

/**
 * Groups `items` by tag and returns one `Cluster` per tag that has reached
 * `CLUSTER_THRESHOLD` members.
 *
 * Sorted alphabetically by tag so the result does not depend on `Map`
 * iteration or filesystem read order.
 *
 * `backlinksMap` is optional for the same reason `getGardenStatsFrom` makes it
 * optional: the disk wrapper passes the real `buildBacklinksMap()` result so
 * the existing mocked test suite keeps passing unmodified, while every browser
 * caller omits it and gets one built purely from `items`.
 */
export function detectClustersFrom(
  items: ContentItem[],
  backlinksMap: Map<string, ContentMeta[]> = buildBacklinksMapFromItems(items)
): Cluster[] {
  const byTag = new Map<string, ContentItem[]>()
  for (const item of items) {
    for (const tag of item.tags) {
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag)!.push(item)
    }
  }

  const clusters: Cluster[] = []
  for (const [tag, members] of byTag) {
    if (members.length < CLUSTER_THRESHOLD) continue

    const stats = computeClusterStatsFrom(members, items, backlinksMap)
    const state = composeCreatureState(stats, null, {
      includeItems: false,
      isOwner: false,
    })
    const speciesLine = assignClusterSpeciesLine({
      tag,
      memberText: members.flatMap((m) => [m.title, m.description]),
    })

    clusters.push({
      tag,
      members,
      speciesLine,
      state,
      isNew: members.length === CLUSTER_THRESHOLD,
    })
  }

  clusters.sort((a, b) => a.tag.localeCompare(b.tag))
  return clusters
}
