import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContentMeta, ContentItem } from '../types'

/**
 * `getGardenStats()` pulls from `getAllContent()` / `getContentItem()`
 * (../content) and `buildBacklinksMap()` (../backlinks), both of which read
 * the real `content/` directory on disk. Mock both so this suite is
 * deterministic and independent of whatever notes happen to exist in the
 * repo at test time.
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

import { getGardenStats } from './stats'

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

function registerNote(
  m: ContentMeta,
  body: string
): void {
  mockContentMeta.push(m)
  mockContentItems[`${m.collection}/${m.slug}`] = { ...m, content: body }
}

beforeEach(() => {
  mockContentMeta = []
  mockContentItems = {}
  mockBacklinks = new Map()
})

describe('getGardenStats: empty garden', () => {
  it('returns all zeros and null dates rather than throwing', () => {
    expect(() => getGardenStats()).not.toThrow()
    const stats = getGardenStats()
    expect(stats.noteCount).toBe(0)
    expect(stats.projectCount).toBe(0)
    expect(stats.totalWords).toBe(0)
    expect(stats.resolvedWikilinks).toBe(0)
    expect(stats.backlinksReceived).toBe(0)
    expect(stats.tagCount).toBe(0)
    expect(stats.maturityCounts).toEqual({ seedling: 0, budding: 0, evergreen: 0 })
    expect(stats.maxBacklinksOnSingleNote).toBe(0)
    expect(stats.firstPublishedAt).toBeNull()
    expect(stats.lastPublishedAt).toBeNull()
  })
})

describe('getGardenStats: word counting', () => {
  it('counts a plain body as whitespace-separated words', () => {
    registerNote(meta({ slug: 'a' }), 'one two three four five')
    const stats = getGardenStats()
    expect(stats.totalWords).toBe(5)
  })

  it('counts zero words for an empty or whitespace-only body', () => {
    registerNote(meta({ slug: 'a' }), '   \n\t  ')
    const stats = getGardenStats()
    expect(stats.totalWords).toBe(0)
  })

  it('sums word counts across multiple notes', () => {
    registerNote(meta({ slug: 'a' }), 'one two three')
    registerNote(meta({ slug: 'b', collection: 'projects', type: 'project' }), 'four five')
    const stats = getGardenStats()
    expect(stats.totalWords).toBe(5)
  })

  it('does not inflate the count on runs of consecutive whitespace (splits on \\s+, not \\s)', () => {
    // Kills stats.ts:23 (`/\s+/` -> `/\s/`): splitting on a single
    // whitespace character instead of a run of them turns every extra
    // space/newline into a spurious empty-string "word".
    registerNote(meta({ slug: 'a' }), 'one   two\n\nthree    four')
    const stats = getGardenStats()
    expect(stats.totalWords).toBe(4)
  })

  it('defaults to zero words (not a placeholder string) when getContentItem finds no matching content', () => {
    // Kills stats.ts:78 (`item?.content ?? ''` -> a non-empty placeholder):
    // registerNote() is skipped here so getContentItem() genuinely returns
    // null for this meta entry, exercising the real fallback.
    mockContentMeta.push(meta({ slug: 'orphaned' }))
    const stats = getGardenStats()
    expect(stats.totalWords).toBe(0)
  })
})

describe('getGardenStats: wikilink resolution', () => {
  it('resolves a plain [[Target]] wikilink against another note title', () => {
    registerNote(meta({ slug: 'target-note', title: 'Target Note' }), 'body')
    registerNote(meta({ slug: 'source', title: 'Source' }), 'See [[Target Note]] for more.')
    const stats = getGardenStats()
    expect(stats.resolvedWikilinks).toBe(1)
  })

  it('resolves the [[Target|alias]] form, using only the target for resolution', () => {
    registerNote(meta({ slug: 'target-note', title: 'Target Note' }), 'body')
    registerNote(
      meta({ slug: 'source', title: 'Source' }),
      'See [[Target Note|this one]] for more.'
    )
    const stats = getGardenStats()
    expect(stats.resolvedWikilinks).toBe(1)
  })

  it('does not count a wikilink whose target does not resolve to a real note', () => {
    registerNote(meta({ slug: 'source', title: 'Source' }), 'See [[Nonexistent Note]] here.')
    const stats = getGardenStats()
    expect(stats.resolvedWikilinks).toBe(0)
  })

  it('counts multiple resolved wikilink occurrences to the same target separately', () => {
    registerNote(meta({ slug: 'target-note', title: 'Target Note' }), 'body')
    registerNote(
      meta({ slug: 'source', title: 'Source' }),
      '[[Target Note]] and again [[Target Note|alias]].'
    )
    const stats = getGardenStats()
    expect(stats.resolvedWikilinks).toBe(2)
  })

  it('resolves purely via the title index, when the slugified target does not match the note\'s actual slug', () => {
    // The target's title is "My Cool Idea!", which slugifies to
    // "my-cool-idea"; the note is deliberately filed under an unrelated
    // slug ("note-42") so resolution can only succeed through the
    // title -> slug map entry, never through the slugify() fallback path.
    // This isolates and kills the title.toLowerCase() -> toUpperCase()
    // mutant (stats.ts:30) and the `||` -> `&&` mutant (stats.ts:46): if
    // either mutates, this link stops resolving.
    registerNote(meta({ slug: 'note-42', title: 'My Cool Idea!' }), 'body')
    registerNote(meta({ slug: 'source', title: 'Source' }), 'See [[My Cool Idea!]] here.')
    const stats = getGardenStats()
    expect(stats.resolvedWikilinks).toBe(1)
  })

  it('resolves via a slug typed directly in the link, when it does not match the note\'s title', () => {
    // The link text is the note's slug, not its title, so resolution can
    // only succeed through the slug index (stats.ts:31), never through a
    // title match. Kills the slug.toLowerCase() -> toUpperCase() mutant.
    registerNote(meta({ slug: 'custom-slug', title: 'A Completely Different Title' }), 'body')
    registerNote(meta({ slug: 'source', title: 'Source' }), 'See [[custom-slug]] here.')
    const stats = getGardenStats()
    expect(stats.resolvedWikilinks).toBe(1)
  })
})

describe('getGardenStats: maturity defaulting', () => {
  it('defaults a note with no maturity field to seedling', () => {
    registerNote(meta({ slug: 'a', maturity: undefined }), 'body')
    const stats = getGardenStats()
    expect(stats.maturityCounts.seedling).toBe(1)
    expect(stats.maturityCounts.budding).toBe(0)
    expect(stats.maturityCounts.evergreen).toBe(0)
  })

  it('respects an explicit maturity field when present', () => {
    registerNote(meta({ slug: 'a', maturity: 'evergreen' }), 'body')
    registerNote(meta({ slug: 'b', maturity: 'budding' }), 'body')
    registerNote(meta({ slug: 'c' }), 'body') // no maturity -> seedling
    const stats = getGardenStats()
    expect(stats.maturityCounts).toEqual({ seedling: 1, budding: 1, evergreen: 1 })
  })
})

describe('getGardenStats: notes vs projects', () => {
  it('splits noteCount and projectCount by collection', () => {
    registerNote(meta({ slug: 'n1', collection: 'notes', type: 'note' }), 'body')
    registerNote(meta({ slug: 'n2', collection: 'notes', type: 'note' }), 'body')
    registerNote(meta({ slug: 'p1', collection: 'projects', type: 'project' }), 'body')
    const stats = getGardenStats()
    expect(stats.noteCount).toBe(2)
    expect(stats.projectCount).toBe(1)
  })
})

describe('getGardenStats: tags', () => {
  it('deduplicates tags into a distinct count', () => {
    registerNote(meta({ slug: 'a', tags: ['garden', 'notes'] }), 'body')
    registerNote(meta({ slug: 'b', tags: ['garden', 'xp'] }), 'body')
    const stats = getGardenStats()
    expect(stats.tagCount).toBe(3)
  })
})

describe('getGardenStats: backlinks', () => {
  it('sums backlinksReceived across all targets and tracks the max on a single note', () => {
    mockContentMeta = [meta({ slug: 'a' }), meta({ slug: 'b' })]
    mockBacklinks = new Map([
      ['a', [meta({ slug: 'x' }), meta({ slug: 'y' }), meta({ slug: 'z' })]],
      ['b', [meta({ slug: 'x' })]],
    ])
    const stats = getGardenStats()
    expect(stats.backlinksReceived).toBe(4)
    expect(stats.maxBacklinksOnSingleNote).toBe(3)
  })
})

describe('getGardenStats: publish dates', () => {
  it('tracks the earliest and latest publish dates across notes', () => {
    registerNote(meta({ slug: 'a', date: '2026-03-01' }), 'body')
    registerNote(meta({ slug: 'b', date: '2026-01-15' }), 'body')
    registerNote(meta({ slug: 'c', date: '2026-06-20' }), 'body')
    const stats = getGardenStats()
    expect(stats.firstPublishedAt).toBe('2026-01-15')
    expect(stats.lastPublishedAt).toBe('2026-06-20')
  })

  it('ignores a note with an unparsable date rather than throwing', () => {
    registerNote(meta({ slug: 'a', date: 'not-a-date' }), 'body')
    expect(() => getGardenStats()).not.toThrow()
    const stats = getGardenStats()
    expect(stats.firstPublishedAt).toBeNull()
    expect(stats.lastPublishedAt).toBeNull()
  })

  it('does not overwrite lastPublishedAt when a later-iterated note is not actually the newest', () => {
    // Kills stats.ts:96's ConditionalExpression "true" and EqualityOperator
    // "!== null" mutants: both make the update unconditional once
    // lastPublishedAt is already set, so whichever note is iterated LAST
    // wins regardless of its actual date. Order the notes so the later
    // one in iteration order is chronologically earlier, which the real
    // `t > ...` guard must reject.
    registerNote(meta({ slug: 'a', date: '2026-06-20' }), 'body')
    registerNote(meta({ slug: 'b', date: '2026-01-15' }), 'body')
    const stats = getGardenStats()
    expect(stats.lastPublishedAt).toBe('2026-06-20')
  })

  it('treats two notes with the exact same publish instant as a non-update (first writer wins for both bounds)', () => {
    // Kills the boundary EqualityOperators on stats.ts:93 (`t <` -> `t <=`)
    // and stats.ts:96 (`t >` -> `t >=`): two date strings can represent the
    // identical instant while differing textually. The strict `<`/`>`
    // comparisons must leave the first-seen string in place; the `<=`/`>=`
    // mutants would overwrite it with the later, textually different string
    // even though the instant did not actually move earlier/later.
    registerNote(meta({ slug: 'a', date: '2026-04-01T00:00:00.000Z' }), 'body')
    registerNote(meta({ slug: 'b', date: '2026-04-01' }), 'body') // same instant, different string
    const stats = getGardenStats()
    expect(stats.firstPublishedAt).toBe('2026-04-01T00:00:00.000Z')
    expect(stats.lastPublishedAt).toBe('2026-04-01T00:00:00.000Z')
  })
})
