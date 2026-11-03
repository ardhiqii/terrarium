/**
 * Wikilink parsing.
 *
 * `[[Note#Heading]]` is one page plus a section. Two callers resolve that form (backlinks and
 * statistics, via `extractWikilinks`, and the MDX renderer) and one does not (the editor, which
 * stores the target verbatim). These tests pin the difference so nobody "simplifies" it by
 * trimming inside `parseWikilink` and starts dropping anchors on save.
 */
import { describe, expect, it } from 'vitest'
import { extractWikilinks, parseWikilink, splitWikilinkTarget } from './utils'

describe('parseWikilink', () => {
  it('splits an alias and keeps the target verbatim', () => {
    expect(parseWikilink('Target|shown')).toEqual({ target: 'Target', label: 'shown' })
    expect(parseWikilink('Target')).toEqual({ target: 'Target', label: 'Target' })
    expect(parseWikilink('Target|')).toEqual({ target: 'Target', label: 'Target' })
  })

  it('leaves an anchor ON the target, because the editor round-trips this value', () => {
    // Trimming here would make `[[Note#Heading]]` save back as `[[Note]]` the next time the
    // note is opened in the editor: silent data loss on an unrelated edit.
    expect(parseWikilink('Note#Heading').target).toBe('Note#Heading')
    expect(parseWikilink('Note#Heading|see below')).toEqual({
      target: 'Note#Heading',
      label: 'see below',
    })
  })
})

describe('splitWikilinkTarget', () => {
  it('separates the page from the anchor', () => {
    expect(splitWikilinkTarget('Note#Heading')).toEqual({ target: 'Note', anchor: 'Heading' })
    expect(splitWikilinkTarget('Note')).toEqual({ target: 'Note', anchor: '' })
    expect(splitWikilinkTarget('Note#A#B')).toEqual({ target: 'Note', anchor: 'A#B' })
    expect(splitWikilinkTarget('  Note #  Heading  ')).toEqual({ target: 'Note', anchor: 'Heading' })
  })
})

describe('extractWikilinks', () => {
  it('returns page names with aliases and anchors stripped, matching the XP resolver', () => {
    // markdown-events.ts matches on `[^\]|#]+`, so an anchored link already earned XP. These
    // two forms returned 'Note#Heading' here, so the same link resolved for XP and resolved to
    // nothing for backlinks, `resolvedWikilinks`, and the cluster map.
    const body = [
      'Plain [[Note]] link.',
      'Anchored [[Note#Heading]] link.',
      'Both [[Note#Heading|see the heading]] at once.',
      'Repeated [[Note]] link.',
    ].join('\n')

    expect(extractWikilinks(body)).toEqual(['Note', 'Note', 'Note', 'Note'])
  })

  it('keeps a target that has no page part out of the result', () => {
    expect(extractWikilinks('[[#only-an-anchor]]')).toEqual([])
  })

  it('reads the same file twice in a row', () => {
    // WIKILINK_REGEX carries the `g` flag; a stale `lastIndex` would make the second call
    // silently return nothing.
    expect(extractWikilinks('[[A]]')).toEqual(['A'])
    expect(extractWikilinks('[[A]]')).toEqual(['A'])
  })
})
