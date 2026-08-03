import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContentMeta, ContentItem } from '../types'

/**
 * `detectClusters()` pulls from `getAllContent()` / `getContentItem()`
 * (../content) and `buildBacklinksMap()` (../backlinks), exactly like
 * `getGardenStats()` does. Mock both so this suite is deterministic and
 * independent of whatever tags/notes happen to exist in the repo at test
 * time (see stats.test.ts for the same pattern).
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

import { detectClusters, CLUSTER_THRESHOLD } from './clusters'
import { getGardenStats } from './stats'
import { computeGardenXp } from './xp'

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

/** Registers `count` distinct notes all tagged `tag`, each with `wordsPer`
 * words of body copy, titled/described so the tag-name theme match always
 * wins over the text fallback (keeps XP-focused tests theme-neutral). */
function registerCluster(
  tag: string,
  count: number,
  wordsPer: number,
  opts: { startDate?: string } = {}
): void {
  for (let i = 0; i < count; i++) {
    registerNote(
      meta({
        slug: `${tag}-${i}`,
        title: `${tag} note ${i}`,
        tags: [tag],
        date: opts.startDate ?? '2026-01-01',
      }),
      Array(wordsPer).fill('word').join(' ')
    )
  }
}

beforeEach(() => {
  mockContentMeta = []
  mockContentItems = {}
  mockBacklinks = new Map()
})

describe('detectClusters: threshold', () => {
  it('produces no cluster for a tag below CLUSTER_THRESHOLD notes', () => {
    registerCluster('design', CLUSTER_THRESHOLD - 1, 50)
    expect(detectClusters()).toEqual([])
  })

  it('produces a cluster for a tag at exactly CLUSTER_THRESHOLD notes', () => {
    registerCluster('design', CLUSTER_THRESHOLD, 50)
    const clusters = detectClusters()
    expect(clusters).toHaveLength(1)
    expect(clusters[0].tag).toBe('design')
    expect(clusters[0].members).toHaveLength(CLUSTER_THRESHOLD)
  })

  it('produces a cluster for a tag above CLUSTER_THRESHOLD notes', () => {
    registerCluster('design', CLUSTER_THRESHOLD + 3, 50)
    const clusters = detectClusters()
    expect(clusters).toHaveLength(1)
    expect(clusters[0].members).toHaveLength(CLUSTER_THRESHOLD + 3)
  })

  it('a single note produces no cluster on its own tag', () => {
    registerCluster('solo-tag', 1, 500)
    expect(detectClusters()).toEqual([])
  })
})

describe('detectClusters: XP inheritance (the core rule)', () => {
  it('a hatched cluster does NOT start at stage 1: real notes push it well past sporeling', () => {
    // Five substantial, well-linked notes. Each note alone is well under
    // the 1500 XP mossling threshold (100 base + a handful of word/link
    // XP), but five of them, PLUS resolved wikilinks between them, should
    // clear it -- proving the companion inherits cluster XP rather than
    // spawning fresh.
    for (let i = 0; i < CLUSTER_THRESHOLD; i++) {
      const links = Array.from({ length: CLUSTER_THRESHOLD - 1 }, (_, j) =>
        j === i ? '' : `[[design note ${j}]]`
      )
        .filter(Boolean)
        .join(' ')
      registerNote(
        meta({
          slug: `design-${i}`,
          title: `design note ${i}`,
          tags: ['design'],
          maturity: 'evergreen',
        }),
        `${Array(1500).fill('word').join(' ')} ${links}`
      )
    }
    const clusters = detectClusters()
    expect(clusters).toHaveLength(1)
    const cluster = clusters[0]

    // Sanity: this is a real, non-zero measurement, not a stub. totalWords
    // is a floor (>=), not exact equality, since the wikilink markup itself
    // ("[[design note 1]]") is whitespace-split into extra "words" too.
    expect(cluster.state.stats.noteCount).toBe(CLUSTER_THRESHOLD)
    expect(cluster.state.stats.totalWords).toBeGreaterThanOrEqual(CLUSTER_THRESHOLD * 1500)
    expect(cluster.state.stats.resolvedWikilinks).toBeGreaterThan(0)

    // The proof: totalXp clears the mossling threshold (1500), and the
    // resolved stage is past the starting stage (index 1 = sporeling). A
    // fresh, un-inherited companion would sit at totalXp 0 / stage 1
    // regardless of how substantial its cluster's notes are; this asserts
    // the opposite is true.
    expect(cluster.state.totalXp).toBeGreaterThan(1500)
    expect(cluster.state.stage.index).toBeGreaterThan(1)
  })

  it('a cluster with more/denser notes resolves to a HIGHER stage than a sparser one, proving XP is computed, not fixed', () => {
    registerCluster('sparse', CLUSTER_THRESHOLD, 20) // minimal body copy
    registerCluster('dense', CLUSTER_THRESHOLD + 5, 800) // more notes, much more copy

    const clusters = detectClusters()
    const sparse = clusters.find((c) => c.tag === 'sparse')!
    const dense = clusters.find((c) => c.tag === 'dense')!

    expect(dense.state.totalXp).toBeGreaterThan(sparse.state.totalXp)
  })

  it('a cluster companion at exactly stage-1 XP would still resolve via resolveStage, not a hardcoded value', () => {
    // A cluster whose 5 members are all empty-bodied and unlinked earns
    // only the flat "note published" XP (5 * 100 = 500), which sits below
    // the mossling threshold (1500) -- so it correctly stays at sporeling.
    // This confirms the stage is COMPUTED (would change if the formula or
    // stats changed) rather than the hatch path being hardwired to a
    // non-1 stage regardless of input.
    registerCluster('empty-cluster', CLUSTER_THRESHOLD, 0)
    const clusters = detectClusters()
    expect(clusters[0].state.totalXp).toBe(CLUSTER_THRESHOLD * 100 + 25 /* one new tag */)
    expect(clusters[0].state.stage.index).toBe(1)
  })
})

describe('detectClusters: double-count is deliberate (rule: XP is never either/or)', () => {
  it('a cluster note contributes independently to its own cluster regardless of what the main garden would compute', () => {
    // This suite only exercises clusters.ts in isolation (getGardenStats is
    // a separate, untouched pipeline reading the same getAllContent()), so
    // the double-count property is really: cluster XP is computed fresh
    // from the SAME underlying notes without zeroing or excluding them.
    // Prove that by checking the cluster XP reflects all 5 notes' word
    // counts, not some discounted subset.
    registerCluster('writing', CLUSTER_THRESHOLD, 300)
    const cluster = detectClusters()[0]
    expect(cluster.state.stats.totalWords).toBe(CLUSTER_THRESHOLD * 300)
  })

  it('the SAME notes feed both the main garden creature (getGardenStats/computeGardenXp) and the cluster companion, in full, at once', () => {
    // The literal proof of "never either/or": run the exact same mocked
    // content through the main garden pipeline AND the cluster pipeline in
    // the same test and confirm both see the full note set, not a partial
    // or zeroed one on either side.
    registerCluster('writing', CLUSTER_THRESHOLD, 300)

    const gardenStats = getGardenStats()
    const gardenXp = computeGardenXp(gardenStats)
    const gardenTotal = gardenXp.reduce((sum, e) => sum + e.xp, 0)

    const cluster = detectClusters()[0]

    // The garden creature counted all 5 notes...
    expect(gardenStats.noteCount).toBe(CLUSTER_THRESHOLD)
    expect(gardenStats.totalWords).toBe(CLUSTER_THRESHOLD * 300)
    expect(gardenTotal).toBeGreaterThan(0)

    // ...and the cluster companion ALSO counted the exact same 5 notes,
    // independently, not "whatever was left over".
    expect(cluster.state.stats.noteCount).toBe(CLUSTER_THRESHOLD)
    expect(cluster.state.stats.totalWords).toBe(CLUSTER_THRESHOLD * 300)
    expect(cluster.state.totalXp).toBeGreaterThan(0)
  })
})

describe('detectClusters: "new" is derived from member count', () => {
  it('marks a cluster new when it sits at exactly CLUSTER_THRESHOLD notes', () => {
    registerCluster('design', CLUSTER_THRESHOLD, 50)
    expect(detectClusters()[0].isNew).toBe(true)
  })

  it('does not mark a cluster new once it has grown past the threshold', () => {
    registerCluster('design', CLUSTER_THRESHOLD + 1, 50)
    expect(detectClusters()[0].isNew).toBe(false)
  })
})

describe('detectClusters: backlinks are scoped to cluster members', () => {
  it('counts a backlink landing on a cluster member even when the linking note is outside the cluster', () => {
    registerCluster('design', CLUSTER_THRESHOLD, 50)
    mockBacklinks = new Map([
      ['design-0', [meta({ slug: 'outsider', tags: ['unrelated'] })]],
    ])
    const cluster = detectClusters()[0]
    expect(cluster.state.stats.backlinksReceived).toBe(1)
    expect(cluster.state.stats.maxBacklinksOnSingleNote).toBe(1)
  })
})

describe('detectClusters: species assignment', () => {
  it('assigns a real SpeciesLine to every cluster, never an empty/placeholder value', () => {
    registerCluster('design', CLUSTER_THRESHOLD, 50)
    registerCluster('security', CLUSTER_THRESHOLD, 50)
    for (const cluster of detectClusters()) {
      expect(cluster.speciesLine).toBeTruthy()
      expect(cluster.speciesLine.id.length).toBeGreaterThan(0)
    }
  })

  it('the same tag always resolves to the same species line across separate detectClusters() calls', () => {
    registerCluster('design', CLUSTER_THRESHOLD, 50)
    const first = detectClusters()[0].speciesLine.id
    const second = detectClusters()[0].speciesLine.id
    expect(second).toBe(first)
  })
})

describe('detectClusters: ordering', () => {
  it('sorts clusters alphabetically by tag, independent of registration order', () => {
    registerCluster('zeta', CLUSTER_THRESHOLD, 20)
    registerCluster('alpha', CLUSTER_THRESHOLD, 20)
    const tags = detectClusters().map((c) => c.tag)
    expect(tags).toEqual(['alpha', 'zeta'])
  })
})
