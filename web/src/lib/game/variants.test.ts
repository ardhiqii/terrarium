import { describe, it, expect } from 'vitest'
import {
  isWoven,
  isSteady,
  isDeep,
  isBroad,
  isBroadRatio,
  resolveVariant,
  VARIANT_DEFS,
  WOVEN_MIN_ENTRIES,
  WOVEN_LINKS_PER_ENTRY,
  STEADY_STREAK_DAYS,
  DEEP_MIN_ENTRIES,
  DEEP_WORDS_PER_ENTRY,
  DEEP_EVERGREEN_RATIO,
  BROAD_MIN_TAGS,
  BROAD_TAGS_PER_ENTRY,
} from './variants'
import type { GardenStats, GithubStats, Maturity } from './types'

function maturityCounts(overrides: Partial<Record<Maturity, number>> = {}): Record<Maturity, number> {
  return { seedling: 0, budding: 0, evergreen: 0, ...overrides }
}

function stats(overrides: Partial<GardenStats> = {}): GardenStats {
  return {
    noteCount: 0,
    projectCount: 0,
    totalWords: 0,
    resolvedWikilinks: 0,
    backlinksReceived: 0,
    tagCount: 0,
    maturityCounts: maturityCounts(),
    maxBacklinksOnSingleNote: 0,
    firstPublishedAt: null,
    lastPublishedAt: null,
    ...overrides,
  }
}

function github(overrides: Partial<GithubStats> = {}): GithubStats {
  return {
    login: 'someone',
    totalCommits: 0,
    commitsByDay: {},
    gardenCommitsByDay: {},
    currentStreakDays: 0,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  }
}

// Real garden numbers (see T30 report / DESIGN.md): 9 entries, 23 resolved
// wikilinks, 15 tags, 2,577 words, zero evergreen. A typical, reasonably
// tended small garden. It must clear NONE of the four thresholds.
const REAL_GARDEN = stats({
  noteCount: 7,
  projectCount: 2,
  totalWords: 2577,
  resolvedWikilinks: 23,
  tagCount: 15,
  maturityCounts: maturityCounts({ seedling: 9 }),
})

describe('the real garden earns no variant', () => {
  it('misses woven, deep, and broad on GardenStats alone', () => {
    expect(isWoven(REAL_GARDEN)).toBe(false)
    expect(isDeep(REAL_GARDEN)).toBe(false)
    expect(isBroad(REAL_GARDEN)).toBe(false)
  })

  it('misses steady with no GitHub data (the common local dev case)', () => {
    expect(isSteady(null)).toBe(false)
  })

  it('resolveVariant returns null end to end', () => {
    expect(resolveVariant(REAL_GARDEN, null)).toBeNull()
  })
})

describe('isWoven', () => {
  it('fires on a dense-but-small garden (ratio, not count)', () => {
    const dense = stats({
      noteCount: 5,
      projectCount: 1,
      resolvedWikilinks: WOVEN_MIN_ENTRIES * WOVEN_LINKS_PER_ENTRY, // exactly at the ratio
    })
    expect(isWoven(dense)).toBe(true)
  })

  it('fires identically on a much larger garden at the same ratio', () => {
    const bigDense = stats({
      noteCount: 90,
      projectCount: 10,
      resolvedWikilinks: 100 * WOVEN_LINKS_PER_ENTRY,
    })
    expect(isWoven(bigDense)).toBe(true)
  })

  it('does not fire below the minimum entry floor even at a qualifying ratio', () => {
    const tooSmall = stats({
      noteCount: WOVEN_MIN_ENTRIES - 1,
      projectCount: 0,
      resolvedWikilinks: (WOVEN_MIN_ENTRIES - 1) * WOVEN_LINKS_PER_ENTRY,
    })
    expect(isWoven(tooSmall)).toBe(false)
  })

  it('does not fire just under the ratio', () => {
    const almost = stats({
      noteCount: 10,
      projectCount: 0,
      resolvedWikilinks: 10 * WOVEN_LINKS_PER_ENTRY - 1,
    })
    expect(isWoven(almost)).toBe(false)
  })
})

describe('isSteady', () => {
  it('fires on a long unbroken commit streak', () => {
    expect(isSteady(github({ currentStreakDays: STEADY_STREAK_DAYS }))).toBe(true)
  })

  it('does not fire one day short', () => {
    expect(isSteady(github({ currentStreakDays: STEADY_STREAK_DAYS - 1 }))).toBe(false)
  })

  it('does not fire with no GitHub data at all', () => {
    expect(isSteady(null)).toBe(false)
  })
})

describe('isDeep', () => {
  it('fires on a small, wordy, mostly-evergreen garden', () => {
    const deepGarden = stats({
      noteCount: DEEP_MIN_ENTRIES,
      projectCount: 0,
      totalWords: DEEP_MIN_ENTRIES * DEEP_WORDS_PER_ENTRY,
      maturityCounts: maturityCounts({
        evergreen: Math.ceil(DEEP_MIN_ENTRIES * DEEP_EVERGREEN_RATIO),
        seedling: DEEP_MIN_ENTRIES - Math.ceil(DEEP_MIN_ENTRIES * DEEP_EVERGREEN_RATIO),
      }),
    })
    expect(isDeep(deepGarden)).toBe(true)
  })

  it('still fires for a large garden that stays deep per entry', () => {
    // There is no upper bound on entries, deliberately. Sixty long, mostly
    // evergreen notes is the deepest thing this system can describe. An
    // earlier ceiling of 15 made `deep` the only variant you could lose by
    // writing more, which is backwards for this product.
    const large = stats({
      noteCount: 60,
      projectCount: 0,
      totalWords: 60 * DEEP_WORDS_PER_ENTRY,
      maturityCounts: maturityCounts({ evergreen: 60 }),
    })
    expect(isDeep(large)).toBe(true)
  })

  it('does not fire when words per entry falls short', () => {
    const thin = stats({
      noteCount: DEEP_MIN_ENTRIES,
      projectCount: 0,
      totalWords: DEEP_MIN_ENTRIES * (DEEP_WORDS_PER_ENTRY - 1),
      maturityCounts: maturityCounts({ evergreen: DEEP_MIN_ENTRIES }),
    })
    expect(isDeep(thin)).toBe(false)
  })

  it('does not fire when evergreen is a minority', () => {
    const mostlySeedling = stats({
      noteCount: 4,
      projectCount: 0,
      totalWords: 4 * DEEP_WORDS_PER_ENTRY,
      maturityCounts: maturityCounts({ evergreen: 1, seedling: 3 }),
    })
    expect(isDeep(mostlySeedling)).toBe(false)
  })
})

describe('isBroad', () => {
  it('fires on a small garden with a wide tag vocabulary (ratio, not count)', () => {
    const wide = stats({
      noteCount: BROAD_MIN_TAGS,
      projectCount: 0,
      tagCount: Math.ceil(BROAD_MIN_TAGS * BROAD_TAGS_PER_ENTRY),
    })
    expect(isBroad(wide)).toBe(true)
  })

  it('does not fire below the absolute tag-count floor even at a qualifying ratio', () => {
    const tinyButRatioed = stats({
      noteCount: 2,
      projectCount: 0,
      tagCount: Math.ceil(2 * BROAD_TAGS_PER_ENTRY), // ratio qualifies, count does not
    })
    expect(tinyButRatioed.tagCount).toBeLessThan(BROAD_MIN_TAGS)
    expect(isBroad(tinyButRatioed)).toBe(false)
  })

  it('isBroadRatio agrees with isBroad on the same inputs', () => {
    const wide = stats({ noteCount: 10, projectCount: 0, tagCount: 30 })
    expect(isBroad(wide)).toBe(isBroadRatio(10, 30))
  })
})

describe('resolveVariant precedence', () => {
  it('picks deep over woven when a garden qualifies for both', () => {
    // entries must clear WOVEN_MIN_ENTRIES (6) while staying at or under
    // DEEP_MAX_ENTRIES (15), so 6 satisfies both floors at once.
    const entries = WOVEN_MIN_ENTRIES
    const both = stats({
      noteCount: entries,
      projectCount: 0,
      totalWords: entries * DEEP_WORDS_PER_ENTRY,
      resolvedWikilinks: entries * WOVEN_LINKS_PER_ENTRY,
      maturityCounts: maturityCounts({
        evergreen: Math.ceil(entries * DEEP_EVERGREEN_RATIO),
        seedling: entries - Math.ceil(entries * DEEP_EVERGREEN_RATIO),
      }),
    })
    expect(isDeep(both)).toBe(true)
    expect(isWoven(both)).toBe(true)
    expect(resolveVariant(both, null)).toBe('deep')
  })

  it('picks woven over broad when a garden qualifies for both', () => {
    const both = stats({
      noteCount: 10,
      projectCount: 0,
      resolvedWikilinks: 10 * WOVEN_LINKS_PER_ENTRY,
      tagCount: Math.ceil(10 * BROAD_TAGS_PER_ENTRY),
    })
    expect(isWoven(both)).toBe(true)
    expect(isBroad(both)).toBe(true)
    expect(resolveVariant(both, null)).toBe('woven')
  })

  it('picks broad over steady when a garden qualifies for both', () => {
    const both = stats({
      noteCount: BROAD_MIN_TAGS,
      projectCount: 0,
      tagCount: Math.ceil(BROAD_MIN_TAGS * BROAD_TAGS_PER_ENTRY),
    })
    expect(isBroad(both)).toBe(true)
    const g = github({ currentStreakDays: STEADY_STREAK_DAYS })
    expect(isSteady(g)).toBe(true)
    expect(resolveVariant(both, g)).toBe('broad')
  })

  it('falls through to steady only when nothing else qualifies', () => {
    expect(resolveVariant(REAL_GARDEN, github({ currentStreakDays: STEADY_STREAK_DAYS }))).toBe(
      'steady'
    )
  })

  it('returns null when nothing qualifies at all', () => {
    expect(resolveVariant(stats(), null)).toBeNull()
  })
})

describe('VARIANT_DEFS', () => {
  it('has exactly one entry per Variant, with thresholds baked into the requirement copy', () => {
    expect(VARIANT_DEFS).toHaveLength(4)
    const ids = VARIANT_DEFS.map((d) => d.id).sort()
    expect(ids).toEqual(['broad', 'deep', 'steady', 'woven'])
    for (const def of VARIANT_DEFS) {
      expect(def.requirement.length).toBeGreaterThan(0)
      expect(def.label.startsWith('var. ')).toBe(true)
    }
  })
})
