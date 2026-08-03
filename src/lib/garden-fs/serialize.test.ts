import { describe, it, expect } from 'vitest'
import { serializeNote, parseNote, titleToFileName, fileNameToSlug } from './serialize'

describe('serializeNote / parseNote round trip', () => {
  it('round trips title, date, tags, and maturity', () => {
    const raw = serializeNote(
      { title: 'My Note', date: '2026-08-01', tags: ['a', 'b'], maturity: 'budding' },
      'Some **body** text.'
    )

    const { frontMatter, body } = parseNote(raw)

    expect(frontMatter).toEqual({
      title: 'My Note',
      date: '2026-08-01',
      tags: ['a', 'b'],
      maturity: 'budding',
    })
    expect(body.trim()).toBe('Some **body** text.')
  })

  it('omits maturity from the frontmatter block when absent, rather than writing a null', () => {
    const raw = serializeNote({ title: 'Plain', date: '2026-08-01', tags: [] }, 'Body.')

    expect(raw).not.toMatch(/maturity/)
  })

  it('produces standard YAML frontmatter with no proprietary syntax', () => {
    const raw = serializeNote(
      { title: 'A Title', date: '2026-08-01', tags: ['x'] },
      'Body.'
    )

    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toMatch(/^title: A Title$/m)
    expect(raw).toMatch(/^date: '2026-08-01'$/m)
    expect(raw).toMatch(/^tags:\n\s+- x$/m)
  })

  it('is tolerant of a file with no frontmatter at all', () => {
    const { frontMatter, body } = parseNote('Just a plain markdown file.\n')

    expect(frontMatter.title).toBe('')
    expect(frontMatter.tags).toEqual([])
    expect(frontMatter.maturity).toBeUndefined()
    expect(body).toContain('Just a plain markdown file.')
  })

  it('drops a malformed maturity value instead of propagating garbage', () => {
    const { frontMatter } = parseNote(
      '---\ntitle: X\ndate: "2026-08-01"\ntags: []\nmaturity: not-a-real-stage\n---\nBody\n'
    )

    expect(frontMatter.maturity).toBeUndefined()
  })
})

describe('titleToFileName / fileNameToSlug', () => {
  it('slugifies a title into a .md filename', () => {
    expect(titleToFileName('Tools for Thinking')).toBe('tools-for-thinking.md')
  })

  it('strips .md and .mdx extensions alike', () => {
    expect(fileNameToSlug('my-note.md')).toBe('my-note')
    expect(fileNameToSlug('my-note.mdx')).toBe('my-note')
  })
})
