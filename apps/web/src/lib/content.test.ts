/**
 * The content index. There were no tests here at all, and `getContentItem` takes its slug
 * straight from a `[slug]` URL segment.
 */
import { describe, expect, it } from 'vitest'
import { getAllContent, getAllSlugs, getContentItem } from './content'

const REAL_NOTE = 'welcome-to-terrarium'

describe('getContentItem', () => {
  it('reads a note from the collection directory', () => {
    const item = getContentItem('notes', REAL_NOTE)
    expect(item?.slug).toBe(REAL_NOTE)
    expect(item?.href).toBe(`/notes/${REAL_NOTE}`)
    expect(typeof item?.content).toBe('string')
  })

  it('returns null for a slug that does not exist', () => {
    expect(getContentItem('notes', 'no-such-note')).toBeNull()
  })

  it('refuses a traversal segment that WOULD otherwise resolve to a real file', () => {
    // `content/notes` + `../notes/<slug>.mdx` normalises back onto the same real file, so this
    // is not a hypothetical: before the guard these all returned the note, and a deeper
    // segment (`../../../something`) would have read any `.mdx` the process can reach.
    for (const hostile of [
      `../notes/${REAL_NOTE}`,
      `./${REAL_NOTE}`,
      `..%2F${REAL_NOTE}`,
      `nested/${REAL_NOTE}`,
      `/etc/passwd`,
      '',
    ]) {
      expect(getContentItem('notes', hostile), hostile).toBeNull()
    }
  })
})

describe('the content index', () => {
  it('is ordered newest first, with no NaN comparisons', () => {
    const items = getAllContent()
    expect(items.length).toBeGreaterThan(0)
    const times = items.map((item) => Date.parse(item.date))
    for (const time of times) expect(Number.isFinite(time), 'every item needs a parseable date').toBe(true)
    const sorted = [...times].sort((left, right) => right - left)
    expect(times).toEqual(sorted)
  })

  it('lists every note that exists, so static generation cannot miss one', () => {
    const slugs = getAllSlugs('notes').map((entry) => entry.slug)
    expect(slugs).toContain(REAL_NOTE)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})
