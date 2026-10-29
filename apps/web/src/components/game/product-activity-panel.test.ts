import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every "xp to next" must say whose ladder it is.
 *
 * A reviewer read /companions and reported "two different names, two different
 * thresholds, and a progress bar that disagrees with its own label". They were right
 * about what they saw. /companions renders THREE ladders off the same total XP:
 *
 *   A. the garden creature's stage   sporeling 0 -> mossling 1,500 -> bracken 5,000
 *   B. the viewer's rank             Seedling 0 -> Sprout 500 -> Gardener 1,500
 *   C. the companion's own form      Beginning 0 -> Charged 100
 *
 * B and C both used to render inside ProductActivityPanel as bare fractions, and B sat
 * directly under the companion's name, so it read as the companion's rank. Nothing was
 * miscalculated; nothing was attributed either. These tests pin the attribution, so a
 * future edit cannot quietly drop it again.
 *
 * A and B are also deliberately pinned to each other at 1,500 (see the note in
 * titles.ts), which is what made two ladders look like one system. Attribution is what
 * makes them legible as two.
 */
const PANEL = readFileSync(
  join(__dirname, 'ProductActivityPanel.tsx'),
  'utf8',
)

describe('ProductActivityPanel attributes each ladder', () => {
  it('says the rank line is the viewer\'s rank', () => {
    expect(PANEL).toContain('Your rank:')
  })

  it('does not render the rank as a bare, unattributed fraction', () => {
    // The old shape opened the line with the rank name styled as an accent span, with
    // no words before it. That is the exact markup the reviewer misread.
    const oldBareRank = /<p className="font-data mt-2 text-xs"[^>]*>\s*<span style=\{\{ color: 'var\(--accent\)' \}\}>\{title\.title\.name\}<\/span>/
    expect(oldBareRank.test(PANEL)).toBe(false)
  })

  it('labels the companion XP as the companion\'s, not the viewer\'s', () => {
    expect(PANEL).toContain('Companion XP')
    // Whitespace-insensitive on purpose: the value used to be asserted with the JSX's own
    // indentation inside the literal, so reindenting the file failed the test while a wrong
    // number rendered happily.
    expect(PANEL).toMatch(
      /<dd className="font-data mt-1 text-sm">\s*\{\(activeCompanion\?\.xp \?\? 0\)\.toLocaleString\(\)\} xp/u,
    )
  })

  it('says the form progress belongs to this companion', () => {
    expect(PANEL).toContain('Next form (this companion)')
    expect(PANEL).toContain("aria-label=\"Progress to this companion's next form\"")
  })

  it('no longer labels the companion column with the ambiguous word "Progression"', () => {
    expect(PANEL).not.toMatch(/>\s*Progression\s*</)
  })

  it('no longer labels the form bar with the ambiguous phrase "Progress to next form"', () => {
    expect(PANEL).not.toContain('>Progress to next form<')
    expect(PANEL).not.toContain('aria-label="Progress to next form"')
  })

  it('keeps the word xp attached to every fraction it renders', () => {
    // Three fractions used to render as bare "20 / 500" and "20 / 100". Each must carry
    // its unit so a number cannot float free of what it measures.
    const fractions = PANEL.match(/\/ \$\{[^}]*\} xp/g) ?? []
    expect(fractions.length).toBeGreaterThanOrEqual(2)
  })
})
