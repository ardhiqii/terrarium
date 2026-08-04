import { describe, it, expect } from 'vitest'
import { sortNotes, type NoteSummary } from './NoteList'

function n(title: string, fileName: string): NoteSummary {
  return { title, fileName, tags: [] }
}

describe('sortNotes', () => {
  it('sorts alphabetically by title, case-insensitively', () => {
    const notes = [n('banana', 'b.md'), n('Apple', 'a.md'), n('cherry', 'c.md')]
    expect(sortNotes(notes).map((x) => x.title)).toEqual(['Apple', 'banana', 'cherry'])
  })

  it('breaks ties on filename so order is stable across renders', () => {
    const notes = [n('Same', 'z.md'), n('Same', 'a.md')]
    expect(sortNotes(notes).map((x) => x.fileName)).toEqual(['a.md', 'z.md'])
  })

  it('does not mutate the input array', () => {
    const notes = [n('B', 'b.md'), n('A', 'a.md')]
    const original = [...notes]
    sortNotes(notes)
    expect(notes).toEqual(original)
  })
})

// ---------------------------------------------------------------------------
// The flat-list redesign. The sidebar used to group by tag, which rendered a
// note once per tag it carried, so a 7-note garden showed 14 rows under a
// header reading "7 notes". These cover the replacements.
// ---------------------------------------------------------------------------
import { tagCounts, filterByTag, shouldShowMaturity } from './NoteList'

function tagged(title: string, fileName: string, tags: string[]): NoteSummary {
  return { title, fileName, tags }
}

describe('tagCounts', () => {
  it('counts each tag across notes, most used first', () => {
    const notes = [
      tagged('A', 'a.md', ['meta', 'thinking']),
      tagged('B', 'b.md', ['meta']),
      tagged('C', 'c.md', ['meta', 'pkm']),
    ]
    expect(tagCounts(notes)).toEqual([
      { tag: 'meta', count: 3 },
      { tag: 'pkm', count: 1 },
      { tag: 'thinking', count: 1 },
    ])
  })

  it('breaks count ties alphabetically', () => {
    const notes = [tagged('A', 'a.md', ['zebra']), tagged('B', 'b.md', ['apple'])]
    expect(tagCounts(notes).map((t) => t.tag)).toEqual(['apple', 'zebra'])
  })

  it('puts untagged last however many there are', () => {
    const notes = [
      tagged('A', 'a.md', []),
      tagged('B', 'b.md', []),
      tagged('C', 'c.md', []),
      tagged('D', 'd.md', ['solo']),
    ]
    expect(tagCounts(notes).map((t) => t.tag)).toEqual(['solo', 'untagged'])
  })

  it('returns nothing for no notes', () => {
    expect(tagCounts([])).toEqual([])
  })
})

describe('filterByTag', () => {
  const notes = [
    tagged('A', 'a.md', ['meta', 'thinking']),
    tagged('B', 'b.md', ['pkm']),
    tagged('C', 'c.md', []),
  ]

  it('returns everything when no tag is active', () => {
    expect(filterByTag(notes, null)).toHaveLength(3)
  })

  it('matches a note by any of its tags, not just the first', () => {
    expect(filterByTag(notes, 'thinking').map((n) => n.fileName)).toEqual(['a.md'])
  })

  it('selects only untagged notes for the untagged bucket', () => {
    expect(filterByTag(notes, 'untagged').map((n) => n.fileName)).toEqual(['c.md'])
  })

  /**
   * The property the old grouping broke: a note carrying two tags must still
   * be one note. Under grouping it rendered twice.
   */
  it('never yields the same note twice', () => {
    const result = filterByTag(notes, 'meta')
    expect(new Set(result.map((n) => n.fileName)).size).toBe(result.length)
  })
})

describe('shouldShowMaturity', () => {
  it('is false when every note shares one maturity, so the column is dropped', () => {
    const notes: NoteSummary[] = [
      { title: 'A', fileName: 'a.md', tags: [], maturity: 'seedling' },
      { title: 'B', fileName: 'b.md', tags: [], maturity: 'seedling' },
    ]
    expect(shouldShowMaturity(notes)).toBe(false)
  })

  it('treats an absent maturity as seedling, so a mixed-absent list stays quiet', () => {
    const notes: NoteSummary[] = [
      { title: 'A', fileName: 'a.md', tags: [] },
      { title: 'B', fileName: 'b.md', tags: [], maturity: 'seedling' },
    ]
    expect(shouldShowMaturity(notes)).toBe(false)
  })

  it('is true as soon as one note differs', () => {
    const notes: NoteSummary[] = [
      { title: 'A', fileName: 'a.md', tags: [], maturity: 'seedling' },
      { title: 'B', fileName: 'b.md', tags: [], maturity: 'evergreen' },
    ]
    expect(shouldShowMaturity(notes)).toBe(true)
  })

  it('is false for an empty list', () => {
    expect(shouldShowMaturity([])).toBe(false)
  })
})
