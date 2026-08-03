import { describe, it, expect } from 'vitest'
import { matchWikilinkTitles } from './WikilinkAutocomplete'

describe('matchWikilinkTitles', () => {
  it('returns everything, capped, for an empty query', () => {
    const titles = Array.from({ length: 12 }, (_, i) => `Note ${i}`)
    expect(matchWikilinkTitles('', titles)).toHaveLength(8)
  })

  it('ranks prefix matches before mid-string matches', () => {
    const titles = ['Second Brain', 'My Thinking Tools', 'Thinking Tools']
    const result = matchWikilinkTitles('thinking', titles)
    expect(result[0]).toBe('Thinking Tools')
    expect(result).toContain('My Thinking Tools')
    expect(result).not.toContain('Second Brain')
  })

  it('is case-insensitive', () => {
    expect(matchWikilinkTitles('TOOLS', ['Tools for Thinking'])).toEqual([
      'Tools for Thinking',
    ])
  })

  it('excludes titles that do not match at all', () => {
    expect(matchWikilinkTitles('zzz', ['Tools for Thinking'])).toEqual([])
  })
})
