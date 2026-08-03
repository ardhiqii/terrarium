import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContentMeta, ContentItem } from '../types'

/**
 * `getClusterCollection()` goes through `detectClusters()` (clusters.ts),
 * which reads `getAllContent()` / `getContentItem()` (../content) and
 * `buildBacklinksMap()` (../backlinks). Mock both, same pattern as
 * `clusters.test.ts` and `stats.test.ts`, so this is deterministic and
 * independent of the real content directory.
 */

let mockContentMeta: ContentMeta[] = []
let mockContentItems: Record<string, ContentItem> = {}
let mockBacklinks: Map<string, ContentMeta[]> = new Map()

vi.mock('../content', () => ({
  getAllContent: () => mockContentMeta,
  getContentItem: (collection: string, slug: string) =>
    mockContentItems[`${collection}/${slug}`] ?? null,
}))

vi.mock('../backlinks', () => ({
  buildBacklinksMap: () => mockBacklinks,
}))

import { getClusterCollection, type CollectionEntry } from './collection'
import { CLUSTER_THRESHOLD } from './clusters'

function meta(overrides: Partial<ContentMeta> = {}): ContentMeta {
  return {
    title: 'Untitled',
    date: '2026-01-01',
    description: '',
    tags: [],
    type: 'note',
    slug: 'untitled',
    collection: 'notes',
    href: '/notes/untitled',
    ...overrides,
  }
}

function registerNote(m: ContentMeta, body: string): void {
  mockContentMeta.push(m)
  mockContentItems[`${m.collection}/${m.slug}`] = { ...m, content: body }
}

function registerCluster(tag: string, count: number, wordsPer = 100): void {
  for (let i = 0; i < count; i++) {
    registerNote(
      meta({ slug: `${tag}-${i}`, title: `${tag} note ${i}`, tags: [tag] }),
      Array(wordsPer).fill('word').join(' ')
    )
  }
}

beforeEach(() => {
  mockContentMeta = []
  mockContentItems = {}
  mockBacklinks = new Map()
})

describe('getClusterCollection', () => {
  it('returns an empty array when no tag has reached the cluster threshold', () => {
    registerCluster('design', CLUSTER_THRESHOLD - 1)
    expect(getClusterCollection()).toEqual([])
  })

  it('returns one entry per clustered tag, shaped like a CollectionEntry', () => {
    registerCluster('design', CLUSTER_THRESHOLD)
    const entries = getClusterCollection()
    expect(entries).toHaveLength(1)

    const entry: CollectionEntry = entries[0]
    expect(entry.repo).toBe('design')
    expect(entry.language).toBeNull()
    expect(entry.kind).toBe('cluster')
    expect(entry.speciesLine).toBeTruthy()
    expect(entry.state).toBeTruthy()
    expect(entry.state.totalXp).toBeGreaterThan(0)
  })

  it('marks a just-hatched cluster (exactly CLUSTER_THRESHOLD notes) as new', () => {
    registerCluster('design', CLUSTER_THRESHOLD)
    expect(getClusterCollection()[0].isNew).toBe(true)
  })

  it('does not mark a long-standing cluster (above threshold) as new', () => {
    registerCluster('design', CLUSTER_THRESHOLD + 4)
    expect(getClusterCollection()[0].isNew).toBe(false)
  })

  it('never throws even when content is empty (no network dependency, unlike getOwnerCollection)', () => {
    expect(() => getClusterCollection()).not.toThrow()
    expect(getClusterCollection()).toEqual([])
  })

  it('carries each cluster\'s own inherited stage into entry.state, not a shared/default one', () => {
    registerCluster('sparse', CLUSTER_THRESHOLD, 10)
    registerCluster('dense', CLUSTER_THRESHOLD + 10, 900)
    const entries = getClusterCollection()
    const sparse = entries.find((e) => e.repo === 'sparse')!
    const dense = entries.find((e) => e.repo === 'dense')!
    expect(dense.state.totalXp).toBeGreaterThan(sparse.state.totalXp)
  })
})
