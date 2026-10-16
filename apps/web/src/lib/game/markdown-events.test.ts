import { describe, expect, it } from 'vitest'
import { normalizeMarkdownEvents } from './markdown-events'

const companionId = 'pikachu-default'

describe('normalizeMarkdownEvents', () => {
  it('emits derived events for a new note without including note content', () => {
    const events = normalizeMarkdownEvents({
      sourceId: 'vault:main',
      companionId,
      previous: [],
      current: [
        {
          path: 'projects/alpha.md',
          content: `---\ntags: [alpha]\n---\n${'word '.repeat(205)} [[README]]`,
          modifiedAt: '2026-08-28T09:15:00.000Z',
        },
        {
          path: 'README.md',
          content: '# Readme',
          modifiedAt: '2026-08-28T09:00:00.000Z',
        },
      ],
    })

    const categories = events.map((event) => event.category)
    expect(categories.filter((category) => category === 'new-note')).toHaveLength(2)
    expect(categories.filter((category) => category === 'new-words')).toHaveLength(2)
    expect(categories).toContain('resolved-wikilink')
    expect(categories).toContain('qualifying-active-day')
    expect(categories).toContain('work-session')
    expect(events.every((event) => event.provenance === 'local')).toBe(true)
    expect(events.every((event) => !JSON.stringify(event).includes('word word'))).toBe(true)
    expect(events.filter((event) => event.category === 'new-words')).toHaveLength(2)
    expect(events.find((event) => event.category === 'qualifying-active-day')?.cap).toEqual({
      key: 'mounted-markdown:vault:main:2026-08-28:qualifying-active-day',
      limit: 1,
    })
  })

  it('is quiet for an unchanged scan and only counts net new words on edits', () => {
    const previous = [
      {
        path: 'note.md',
        content: 'one two three four five',
        modifiedAt: '2026-08-27T09:00:00.000Z',
      },
    ]

    expect(
      normalizeMarkdownEvents({
        sourceId: 'vault:main',
        companionId,
        previous,
        current: previous,
      }),
    ).toEqual([])

    const edited = normalizeMarkdownEvents({
      sourceId: 'vault:main',
      companionId,
      previous,
      current: [
        {
          ...previous[0],
          content: 'one two three four five six seven eight nine ten eleven twelve',
          modifiedAt: '2026-08-28T11:00:00.000Z',
        },
      ],
    })

    expect(edited.filter((event) => event.category === 'new-words')).toHaveLength(0)
    expect(edited.map((event) => event.category)).toEqual(['qualifying-active-day', 'work-session'])
  })

  it('does not award a new-note bonus for a byte-identical rename', () => {
    const events = normalizeMarkdownEvents({
      sourceId: 'vault:main',
      companionId,
      previous: [{ path: 'old.md', content: '# Same note', modifiedAt: '2026-08-27T09:00:00.000Z' }],
      current: [{ path: 'renamed.md', content: '# Same note', modifiedAt: '2026-08-28T09:00:00.000Z' }],
    })

    expect(events).toEqual([])
  })

  it('uses editor rename proof when frontmatter bytes changed', () => {
    const events = normalizeMarkdownEvents({
      sourceId: 'vault:main',
      companionId,
      previous: [{
        path: 'old-title.md',
        content: '---\ntitle: Old title\n---\nbody',
        modifiedAt: '2026-08-27T09:00:00.000Z',
      }],
      current: [{
        path: 'new-title.md',
        content: '---\ntitle: New title\n---\nbody',
        modifiedAt: '2026-08-28T09:00:00.000Z',
      }],
      renameHints: [{ from: 'old-title.md', to: 'new-title.md' }],
    })

    expect(events.filter((event) => event.category === 'new-note')).toHaveLength(0)
  })

  it('keeps a genuinely duplicated file as a new note when the old path remains', () => {
    const events = normalizeMarkdownEvents({
      sourceId: 'vault:main',
      companionId,
      previous: [{ path: 'old.md', content: '# Same note', modifiedAt: '2026-08-27T09:00:00.000Z' }],
      current: [
        { path: 'old.md', content: '# Same note', modifiedAt: '2026-08-27T09:00:00.000Z' },
        { path: 'copy.md', content: '# Same note', modifiedAt: '2026-08-28T09:00:00.000Z' },
      ],
    })

    expect(events.filter((event) => event.category === 'new-note')).toHaveLength(1)
  })

  it('does not reward a known path as a new note after a reload', () => {
    const events = normalizeMarkdownEvents({
      sourceId: 'vault:main',
      companionId,
      previous: [],
      knownPaths: ['notes/old.md'],
      current: [{
        path: 'notes/old.md',
        content: 'a note that was already seen',
        modifiedAt: '2026-08-28T09:00:00.000Z',
      }],
    })

    expect(events).toEqual([])
  })

  it('does not treat an external rename after reload as a new note or full rewrite', () => {
    const events = normalizeMarkdownEvents({
      sourceId: 'vault:main',
      companionId,
      previous: [],
      knownPaths: ['notes/old.md'],
      current: [{
        path: 'notes/new-title.md',
        content: `${'word '.repeat(120)}[[another-note]]`,
        modifiedAt: '2026-08-28T09:00:00.000Z',
      }],
    })

    expect(events).toEqual([])
  })

  it('rejects unsafe relative paths', () => {
    expect(() =>
      normalizeMarkdownEvents({
        sourceId: 'vault:main',
        companionId,
        previous: [],
        current: [{ path: '../secret.md', content: 'x', modifiedAt: '2026-08-28T09:00:00.000Z' }],
      }),
    ).toThrow('Invalid Markdown path')
  })
})
