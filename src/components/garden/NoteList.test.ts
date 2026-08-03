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
