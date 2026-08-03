import { describe, it, expect } from 'vitest'
import type { ContentItem } from '../types'
import { getGardenStatsFrom, buildBacklinksMapFromItems } from './stats-from-items'

/**
 * `stats.test.ts` exhaustively covers this same logic through the disk
 * wrapper (`getGardenStats()`, mocking `../content`/`../backlinks`). This
 * suite exists to prove the SEPARATE thing that matters for T23: calling the
 * pure function directly, with no backlinks map supplied, over a plain
 * `ContentItem[]` -- exactly the shape `parseGardenFiles()` produces from a
 * browser-connected folder -- produces the same numbers as the disk path
 * would for equivalent content. No mocking of `../content`/`../backlinks`
 * here at all, which is the point: this file must have zero dependency on
 * either.
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

describe('getGardenStatsFrom: empty input', () => {
  it('returns all zeros and null dates for an empty item array, never throwing', () => {
    expect(() => getGardenStatsFrom([])).not.toThrow()
    const stats = getGardenStatsFrom([])
    expect(stats.noteCount).toBe(0)
    expect(stats.totalWords).toBe(0)
    expect(stats.firstPublishedAt).toBeNull()
    expect(stats.lastPublishedAt).toBeNull()
  })
})

describe('getGardenStatsFrom: computed purely from items, no injected backlinks map', () => {
  it('counts words, notes vs projects, and tags from the items alone', () => {
    const items = [
      item({ slug: 'a', collection: 'notes', content: 'one two three', tags: ['x'] }),
      item({ slug: 'b', collection: 'projects', type: 'project', content: 'four five', tags: ['y'] }),
    ]
    const stats = getGardenStatsFrom(items)
    expect(stats.noteCount).toBe(1)
    expect(stats.projectCount).toBe(1)
    expect(stats.totalWords).toBe(5)
    expect(stats.tagCount).toBe(2)
  })

  it('resolves a [[wikilink]] between two items in the same array and derives backlinks from it', () => {
    const items = [
      item({ slug: 'target-note', title: 'Target Note', content: 'body' }),
      item({ slug: 'source', title: 'Source', content: 'See [[Target Note]] for more.' }),
    ]
    const stats = getGardenStatsFrom(items)
    expect(stats.resolvedWikilinks).toBe(1)
    // The backlink landed on target-note, discovered purely from item text,
    // with no backlinks map passed in at all.
    expect(stats.backlinksReceived).toBe(1)
    expect(stats.maxBacklinksOnSingleNote).toBe(1)
  })

  it('does not resolve a wikilink whose target is not in the item array', () => {
    const items = [item({ slug: 'source', title: 'Source', content: '[[Nowhere]]' })]
    const stats = getGardenStatsFrom(items)
    expect(stats.resolvedWikilinks).toBe(0)
    expect(stats.backlinksReceived).toBe(0)
  })

  it('defaults maturity to seedling when absent', () => {
    const items = [item({ slug: 'a', maturity: undefined })]
    const stats = getGardenStatsFrom(items)
    expect(stats.maturityCounts).toEqual({ seedling: 1, budding: 0, evergreen: 0 })
  })

  it('ignores an unparsable date instead of throwing', () => {
    const items = [item({ slug: 'a', date: 'not-a-date' })]
    expect(() => getGardenStatsFrom(items)).not.toThrow()
    const stats = getGardenStatsFrom(items)
    expect(stats.firstPublishedAt).toBeNull()
  })
})

describe('getGardenStatsFrom: an explicit backlinksMap overrides the internally-derived one', () => {
  it('uses the supplied map rather than recomputing from item text', () => {
    const items = [item({ slug: 'a' }), item({ slug: 'b' })]
    const backlinksMap = new Map([
      ['a', [item({ slug: 'x' }), item({ slug: 'y' })]],
    ])
    const stats = getGardenStatsFrom(items, backlinksMap)
    expect(stats.backlinksReceived).toBe(2)
    expect(stats.maxBacklinksOnSingleNote).toBe(2)
  })
})

describe('buildBacklinksMapFromItems', () => {
  it('dedupes multiple links from the same source note to the same target', () => {
    const items = [
      item({ slug: 'target', title: 'Target', content: 'body' }),
      item({ slug: 'source', title: 'Source', content: '[[Target]] and again [[Target|alias]]' }),
    ]
    const map = buildBacklinksMapFromItems(items)
    expect(map.get('target')).toHaveLength(1)
  })

  it('resolves a link via the slug when it does not match any title', () => {
    const items = [
      item({ slug: 'custom-slug', title: 'A Different Title', content: 'body' }),
      item({ slug: 'source', title: 'Source', content: '[[custom-slug]]' }),
    ]
    const map = buildBacklinksMapFromItems(items)
    expect(map.get('custom-slug')).toHaveLength(1)
  })
})
