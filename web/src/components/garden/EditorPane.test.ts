import { describe, it, expect } from 'vitest'
import { detectWikilinkTrigger, computeDraftXpPreview } from './EditorPane'

describe('detectWikilinkTrigger', () => {
  it('detects an open, unclosed [[ before the caret', () => {
    const text = 'See [[Too'
    const trigger = detectWikilinkTrigger(text, text.length)
    expect(trigger).toEqual({ start: 4, query: 'Too' })
  })

  it('returns null once the link has been closed', () => {
    const text = 'See [[Tools]] already linked'
    expect(detectWikilinkTrigger(text, text.length)).toBeNull()
  })

  it('returns null when there is no [[ at all', () => {
    expect(detectWikilinkTrigger('plain text', 5)).toBeNull()
  })

  it('returns null across a newline, so a stray [[ on an earlier line does not leak', () => {
    const text = '[[Unclosed\nNext line'
    expect(detectWikilinkTrigger(text, text.length)).toBeNull()
  })

  it('tracks the most recently opened [[ when two appear', () => {
    const text = '[[First]] and [[Sec'
    expect(detectWikilinkTrigger(text, text.length)).toEqual({ start: 14, query: 'Sec' })
  })
})

describe('computeDraftXpPreview', () => {
  it('always counts the note-published entry for a draft', () => {
    const entries = computeDraftXpPreview('', [])
    const notePublished = entries.find((e) => e.source === 'note-published')
    expect(notePublished?.count).toBe(1)
    expect(notePublished?.xp).toBeGreaterThan(0)
  })

  it('counts words using the same rate as the real XP pipeline', () => {
    const body = Array.from({ length: 200 }, () => 'word').join(' ')
    const entries = computeDraftXpPreview(body, [])
    const words = entries.find((e) => e.source === 'words')
    expect(words?.count).toBe(2) // 200 words = 2 hundreds
  })

  it('only counts a wikilink as XP when it resolves against a real title', () => {
    const body = '[[Real Note]] and [[Nonexistent Note]]'
    const entries = computeDraftXpPreview(body, ['Real Note'])
    const wikilink = entries.find((e) => e.source === 'wikilink')
    expect(wikilink?.count).toBe(1)
  })

  it('resolves a slug-form link against a known title, same as the real resolver', () => {
    const body = '[[real-note]]'
    const entries = computeDraftXpPreview(body, ['Real Note'])
    const wikilink = entries.find((e) => e.source === 'wikilink')
    expect(wikilink?.count).toBe(1)
  })

  it('omits zero-count entries, so backlinks/tags never show as false +0 lines', () => {
    const entries = computeDraftXpPreview('some words here', [])
    expect(entries.some((e) => e.source === 'backlink')).toBe(false)
    expect(entries.some((e) => e.source === 'tag')).toBe(false)
  })
})
