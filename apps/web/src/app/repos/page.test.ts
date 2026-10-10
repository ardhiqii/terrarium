import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getClusterCollection } from '../../lib/game/collection'

/**
 * A cluster card must say WHY it exists, and must not sit in a list about repositories.
 *
 * WHAT WENT WRONG: `/repos` rendered `[...clusterCollection, ...repoCollection]` as one
 * grid, clusters first. So a tag-cluster card appeared directly under the dress section's
 * "No tracked repositories yet" message. Both statements were true -- no GitHub repo was
 * tracked, and the `demo` tag did reach five content items -- but nothing on the page said
 * the card was a cluster rather than a repository, and the card itself showed only
 * "Cluster · Grass line" with no count. Reading it, the owner asked "why is this here".
 */
const PAGE = readFileSync(join(__dirname, 'page.tsx'), 'utf8')
const GRID = readFileSync(
  join(__dirname, '..', '..', 'components', 'game', 'CollectionGrid.tsx'),
  'utf8',
)

describe('a cluster entry carries the count that earned it', () => {
  it('reports memberCount for every cluster, and it clears the threshold', () => {
    const clusters = getClusterCollection()
    expect(clusters.length).toBeGreaterThan(0)
    for (const entry of clusters) {
      expect(entry.kind).toBe('cluster')
      expect(typeof entry.memberCount).toBe('number')
      // The load-bearing assertion: a cluster exists BECAUSE its tag crossed
      // CLUSTER_THRESHOLD (5). If a card ever appears below the threshold, the count it
      // reports is the evidence, and this fails. Counting only `content/notes` here once
      // made the `demo` tag look like 4 notes and the card look like a bug; it is 5,
      // because `content/projects/terrarium-demo.mdx` carries the tag too.
      expect(entry.memberCount!).toBeGreaterThanOrEqual(5)
    }
  })

  it('renders that count on the tile', () => {
    expect(GRID).toContain('entry.memberCount')
    expect(GRID).toContain('of ${entry.memberCount} notes')
    // The old line was `Cluster · ${entry.speciesLine.name}`, with no number at all.
    expect(GRID).not.toContain('Cluster · ${entry.speciesLine.name}')
  })
})

describe('/repos keeps repositories and tag clusters apart', () => {
  it('does not merge the two collections into a single grid', () => {
    // Assert on the VARIABLE, not on the spread expression: the block comment above the
    // sections quotes the old merged form on purpose, so grepping for it would match the
    // documentation of the bug rather than the bug.
    expect(PAGE).not.toContain('const entries')
    expect(PAGE).not.toContain('entries={entries}')
  })

  it('gives each list its own heading, blurb, and empty state', () => {
    expect(PAGE).toContain('Repositories')
    expect(PAGE).toContain('Tag clusters')
    expect(PAGE).toContain('entries={repoCollection}')
    expect(PAGE).toContain('entries={clusterCollection}')
    // One sentence describing both kinds is wrong in either section, so each supplies its
    // own reason for being empty.
    expect(PAGE).toContain('No repository creatures yet.')
    expect(PAGE).toContain('No tag has reached five notes yet.')
  })

  it('lets the caller override the grid empty state', () => {
    expect(GRID).toContain('emptyMessage')
    expect(GRID).toContain('emptyMessage ?? (')
  })
})
