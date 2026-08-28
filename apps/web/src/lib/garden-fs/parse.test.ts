import { describe, it, expect } from 'vitest'
import { parseFrontMatter, parseGardenFile, parseGardenFiles, titleFromFilename } from './parse'
import type { GardenFile } from './types'

function file(name: string, content: string): GardenFile {
  return { name, content }
}

describe('parseFrontMatter', () => {
  it('parses scalar fields out of a standard frontmatter block', () => {
    const raw = [
      '---',
      'title: My Note',
      'date: 2026-01-15',
      'description: A short summary',
      'type: note',
      'maturity: budding',
      '---',
      'Body text here.',
    ].join('\n')

    const { data, content } = parseFrontMatter(raw)
    expect(data.title).toBe('My Note')
    expect(data.date).toBe('2026-01-15')
    expect(data.description).toBe('A short summary')
    expect(data.type).toBe('note')
    expect(data.maturity).toBe('budding')
    expect(content).toBe('Body text here.')
  })

  it('parses an inline tags array', () => {
    const raw = '---\ntitle: X\ntags: [garden, notes, xp]\n---\nBody'
    const { data } = parseFrontMatter(raw)
    expect(data.tags).toEqual(['garden', 'notes', 'xp'])
  })

  it('parses a YAML block-list tags field', () => {
    const raw = ['---', 'title: X', 'tags:', '  - garden', '  - notes', '---', 'Body'].join('\n')
    const { data } = parseFrontMatter(raw)
    expect(data.tags).toEqual(['garden', 'notes'])
  })

  it('strips single and double quotes from scalar values', () => {
    const raw = '---\ntitle: "Quoted Title"\ndescription: \'Single quoted\'\n---\nBody'
    const { data } = parseFrontMatter(raw)
    expect(data.title).toBe('Quoted Title')
    expect(data.description).toBe('Single quoted')
  })

  it('returns empty data and the whole file as content when there is no frontmatter block at all', () => {
    const raw = 'Just a plain markdown file with no frontmatter.\n\nSecond paragraph.'
    const { data, content } = parseFrontMatter(raw)
    expect(data).toEqual({})
    expect(content).toBe(raw)
  })

  it('does not throw on a malformed/unterminated frontmatter block', () => {
    const raw = '---\ntitle: Broken\nno closing delimiter here'
    expect(() => parseFrontMatter(raw)).not.toThrow()
  })

  it('does not throw on an empty file', () => {
    expect(() => parseFrontMatter('')).not.toThrow()
    expect(parseFrontMatter('').content).toBe('')
  })
})

describe('titleFromFilename', () => {
  it('derives a title-cased title from a dashed filename', () => {
    expect(titleFromFilename('my-cool-idea.md')).toBe('My Cool Idea')
  })

  it('derives a title from an underscored filename', () => {
    expect(titleFromFilename('second_brain_notes.mdx')).toBe('Second Brain Notes')
  })
})

describe('parseGardenFile: the common case (no frontmatter)', () => {
  it('never throws and derives a title from the filename', () => {
    const f = file('quick-thought.md', 'Just some text, no frontmatter block.')
    expect(() => parseGardenFile(f)).not.toThrow()
    const item = parseGardenFile(f)
    expect(item.title).toBe('Quick Thought')
    expect(item.content).toBe('Just some text, no frontmatter block.')
  })

  it('defaults tags to an empty array, type to note, and maturity to undefined', () => {
    const item = parseGardenFile(file('plain.md', 'body'))
    expect(item.tags).toEqual([])
    expect(item.type).toBe('note')
    expect(item.maturity).toBeUndefined()
    expect(item.collection).toBe('notes')
  })

  it('defaults date and description to empty strings rather than throwing on missing fields', () => {
    const item = parseGardenFile(file('plain.md', 'body'))
    expect(item.date).toBe('')
    expect(item.description).toBe('')
  })
})

describe('parseGardenFile: frontmatter present', () => {
  it('uses the frontmatter title over the filename-derived one', () => {
    const raw = '---\ntitle: Real Title\n---\nBody'
    const item = parseGardenFile(file('some-slug.md', raw))
    expect(item.title).toBe('Real Title')
  })

  it('routes type: project to the projects collection', () => {
    const raw = '---\ntitle: A Project\ntype: project\n---\nBody'
    const item = parseGardenFile(file('proj.md', raw))
    expect(item.type).toBe('project')
    expect(item.collection).toBe('projects')
    expect(item.href).toBe('/projects/proj')
  })

  it('only accepts a maturity value from the known set, discarding an invalid one', () => {
    const raw = '---\ntitle: X\nmaturity: not-a-real-value\n---\nBody'
    const item = parseGardenFile(file('x.md', raw))
    expect(item.maturity).toBeUndefined()
  })

  it('accepts a valid maturity value', () => {
    const raw = '---\ntitle: X\nmaturity: evergreen\n---\nBody'
    const item = parseGardenFile(file('x.md', raw))
    expect(item.maturity).toBe('evergreen')
  })

  it('treats .md and .mdx the same way for slug derivation', () => {
    const a = parseGardenFile(file('same-name.md', '---\ntitle: A\n---\nBody'))
    const b = parseGardenFile(file('same-name.mdx', '---\ntitle: B\n---\nBody'))
    expect(a.slug).toBe(b.slug)
  })
})

describe('parseGardenFiles', () => {
  it('parses a batch and never lets one file abort the rest', () => {
    const files = [
      file('a.md', '---\ntitle: A\n---\nBody A'),
      file('b.md', 'No frontmatter at all'),
      file('c.md', ''),
    ]
    expect(() => parseGardenFiles(files)).not.toThrow()
    const items = parseGardenFiles(files)
    expect(items).toHaveLength(3)
    expect(items[0].title).toBe('A')
    expect(items[1].title).toBe('B')
  })
})
