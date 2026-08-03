import { describe, it, expect } from 'vitest'
import type { ContentItem } from '../types'
import { detectClustersFrom, CLUSTER_THRESHOLD } from './clusters'

/**
 * `clusters.test.ts` covers `detectClusters()` (the disk wrapper) exhaustively
 * via mocked `../content`/`../backlinks`. This file proves the separate thing
 * T23 needs: calling `detectClustersFrom` directly over a plain
 * `ContentItem[]`, with no backlinks map supplied and no mocking of
 * `../content`/`../backlinks` at all -- the exact shape a browser-connected
 * folder produces via `parseGardenFiles()`.
 */

function item(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    title: 'Untitled',
    date: '2026-01-01',
    description: '',
    tags: [],
    type: 'note',
    slug: 'untitled',
    collection: 'notes',
    href: '/notes/untitled',
    content: '',
    ...overrides,
  }
}

function cluster(tag: string, count: number, wordsPer: number): ContentItem[] {
  return Array.from({ length: count }, (_, i) =>
    item({
      slug: `${tag}-${i}`,
      title: `${tag} note ${i}`,
      tags: [tag],
      content: Array(wordsPer).fill('word').join(' '),
    })
  )
}

describe('detectClustersFrom: purely from items, no disk, no injected backlinks map', () => {
  it('produces no cluster below CLUSTER_THRESHOLD', () => {
    expect(detectClustersFrom(cluster('design', CLUSTER_THRESHOLD - 1, 50))).toEqual([])
  })

  it('produces a cluster at exactly CLUSTER_THRESHOLD, marked new', () => {
    const clusters = detectClustersFrom(cluster('design', CLUSTER_THRESHOLD, 50))
    expect(clusters).toHaveLength(1)
    expect(clusters[0].tag).toBe('design')
    expect(clusters[0].isNew).toBe(true)
  })

  it('inherits real XP from cluster member word counts, not a fresh stage 1', () => {
    const items = cluster('writing', CLUSTER_THRESHOLD, 1000)
    const clusters = detectClustersFrom(items)
    expect(clusters[0].state.totalXp).toBeGreaterThan(500) // more than just note-published XP
  })

  it('resolves in-cluster wikilinks into backlinks without any external backlinks map', () => {
    const items = [
      item({ slug: 'target-note', title: 'Target Note', tags: ['design'], content: 'body' }),
      ...cluster('design', CLUSTER_THRESHOLD - 1, 20).map((n, i) =>
        i === 0 ? { ...n, content: `${n.content} [[Target Note]]` } : n
      ),
    ]
    const clusters = detectClustersFrom(items)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].state.stats.backlinksReceived).toBeGreaterThanOrEqual(1)
  })

  it('sorts clusters alphabetically by tag regardless of registration order', () => {
    const items = [...cluster('zeta', CLUSTER_THRESHOLD, 20), ...cluster('alpha', CLUSTER_THRESHOLD, 20)]
    const tags = detectClustersFrom(items).map((c) => c.tag)
    expect(tags).toEqual(['alpha', 'zeta'])
  })
})
