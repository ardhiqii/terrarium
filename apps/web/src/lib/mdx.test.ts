/**
 * Wikilink → href resolution in the MDX renderer.
 *
 * Split out of `renderMDX` so it can be asserted without building an mdast tree or pulling the
 * RSC pipeline into a unit test. The anchored case is the one that was wrong: `[[Note#Heading]]`
 * looked up the key `note#heading`, missed, and fell through to an in-page `#note-heading` —
 * a dead link on a note that exists.
 */
import { describe, expect, it } from 'vitest'
import { wikilinkHrefFor } from './mdx'

const lookup = new Map<string, string>([
  ['welcome to terrarium', '/notes/welcome-to-terrarium'],
  ['welcome-to-terrarium', '/notes/welcome-to-terrarium'],
  ['how companions grow', '/notes/how-companions-grow'],
])

describe('wikilinkHrefFor', () => {
  it('resolves a plain title, case-insensitively', () => {
    expect(wikilinkHrefFor('Welcome to Terrarium', lookup)).toBe('/notes/welcome-to-terrarium')
    expect(wikilinkHrefFor('welcome to terrarium', lookup)).toBe('/notes/welcome-to-terrarium')
  })

  it('resolves by slug too', () => {
    expect(wikilinkHrefFor('welcome-to-terrarium', lookup)).toBe('/notes/welcome-to-terrarium')
  })

  it('keeps the anchor on an anchored link instead of rendering a dead one', () => {
    expect(wikilinkHrefFor('Welcome to Terrarium#Getting started', lookup)).toBe(
      '/notes/welcome-to-terrarium#Getting started',
    )
  })

  it('falls back to an in-page anchor, without doubling the hash, when the page is unknown', () => {
    expect(wikilinkHrefFor('Nobody Wrote This', lookup)).toBe('#nobody-wrote-this')
    expect(wikilinkHrefFor('Nobody Wrote This#Section', lookup)).toBe('#nobody-wrote-this')
  })
})
