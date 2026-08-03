import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContentMeta } from '../types'

// `items.ts` pulls note dates from `getAllContent()` (Dew Vial's streak
// calculation). That reads the real `content/` directory at build time,
// which would make these tests non-deterministic and liable to break the
// moment a real note is added. Mock it so every test controls its own
// "active days" fixture.
const mockGetAllContent = vi.fn<() => ContentMeta[]>(() => [])
vi.mock('../content', () => ({
  getAllContent: () => mockGetAllContent(),
}))

// Import after the mock is registered.
import { ITEMS, GARDEN_ITEMS, COMMIT_ITEMS } from './items'
import { composeCreatureState, emptyGardenStats } from './repo-creature'
import { GardenStats, GithubStats, UnlockContext } from './types'

function stats(overrides: Partial<GardenStats> = {}): GardenStats {
  return {
    noteCount: 0,
    projectCount: 0,
    totalWords: 0,
    resolvedWikilinks: 0,
    backlinksReceived: 0,
    tagCount: 0,
    maturityCounts: { seedling: 0, budding: 0, evergreen: 0 },
    maxBacklinksOnSingleNote: 0,
    firstPublishedAt: null,
    lastPublishedAt: null,
    ...overrides,
  }
}

function github(overrides: Partial<GithubStats> = {}): GithubStats {
  return {
    login: 'test-user',
    totalCommits: 0,
    commitsByDay: {},
    gardenCommitsByDay: {},
    currentStreakDays: 0,
    fetchedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Owner note dates now arrive on `UnlockContext` rather than being read from
 * `getAllContent()` inside `items.ts`. That import dragged `fs` into any
 * browser bundle using the item system, which broke the client-side garden.
 *
 * These tests still express intent by setting `mockGetAllContent`, so this
 * helper does the conversion the server now does in `state.ts`, keeping every
 * existing case meaningful without rewriting each one.
 */
function ctx(overrides: Partial<UnlockContext> = {}): UnlockContext {
  const base: UnlockContext = {
    stats: stats(),
    github: null,
    isOwner: false,
    ...overrides,
  }
  if (base.ownerNoteDays !== undefined) return base

  const days: string[] = []
  for (const contentItem of mockGetAllContent()) {
    if (!contentItem.date) continue
    const t = new Date(contentItem.date)
    if (!Number.isNaN(t.getTime())) days.push(t.toISOString().slice(0, 10))
  }
  return { ...base, ownerNoteDays: days }
}

function item(id: string) {
  const found = ITEMS.find((i) => i.id === id)
  if (!found) throw new Error(`no item "${id}"`)
  return found
}

/** YYYY-MM-DD for N days before "now", at local midnight. */
function daysAgoISO(n: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function contentWithDates(dates: string[]): ContentMeta[] {
  return dates.map((date, i) => ({
    title: `note-${i}`,
    date,
    description: '',
    tags: [],
    type: 'note',
    slug: `note-${i}`,
    collection: 'notes',
    href: `/notes/note-${i}`,
  }))
}

beforeEach(() => {
  mockGetAllContent.mockReset()
  mockGetAllContent.mockReturnValue([])
})

const emptyCtx = ctx()

describe('ITEMS', () => {
  it('is locked for every item against an empty garden', () => {
    for (const def of ITEMS) {
      expect(def.unlocked(emptyCtx)).toBe(false)
    }
  })

  it('does not throw for any item when ctx.github is null, and returns false/0', () => {
    for (const def of ITEMS) {
      expect(() => def.unlocked(emptyCtx)).not.toThrow()
      expect(() => def.progress(emptyCtx)).not.toThrow()
      expect(def.unlocked(emptyCtx)).toBe(false)
      expect(def.progress(emptyCtx)).toBe(0)
    }
  })

  it('keeps progress between 0 and 1 for every item across a spread of stats', () => {
    const spreadStats: GardenStats[] = [
      stats(),
      stats({ noteCount: 2, projectCount: 0, tagCount: 3, maxBacklinksOnSingleNote: 2 }),
      stats({ noteCount: 25, projectCount: 5, tagCount: 10, maxBacklinksOnSingleNote: 5 }),
      stats({ noteCount: 1000, tagCount: 1000, maxBacklinksOnSingleNote: 1000 }),
      stats({ maturityCounts: { seedling: 0, budding: 1, evergreen: 0 } }),
      stats({ maturityCounts: { seedling: 0, budding: 0, evergreen: 1 } }),
    ]
    for (const def of ITEMS) {
      for (const s of spreadStats) {
        const p = def.progress(ctx({ stats: s }))
        expect(p).toBeGreaterThanOrEqual(0)
        expect(p).toBeLessThanOrEqual(1)
      }
    }
  })

  it('reports progress exactly 1 whenever unlocked is true', () => {
    // For each item, construct a context that should unlock it, then verify
    // both unlocked === true and progress === 1.
    const unlockingCtxs: Record<string, UnlockContext> = {
      'spore-jar': ctx({ stats: stats({ noteCount: 5 }) }),
      'dew-vial': (() => {
        mockGetAllContent.mockReturnValueOnce(
          contentWithDates([
            daysAgoISO(0),
            daysAgoISO(1),
            daysAgoISO(2),
            daysAgoISO(3),
            daysAgoISO(4),
            daysAgoISO(5),
            daysAgoISO(6),
          ])
        )
        return ctx({ isOwner: true })
      })(),
      'hand-lens': ctx({ stats: stats({ maxBacklinksOnSingleNote: 5 }) }),
      trowel: ctx({ stats: stats({ projectCount: 1 }) }),
      'field-ledger': ctx({ stats: stats({ noteCount: 25 }) }),
      'brass-compass': ctx({ stats: stats({ tagCount: 10 }) }),
      'pressed-frond': ctx({
        stats: stats({ maturityCounts: { seedling: 0, budding: 0, evergreen: 1 } }),
      }),
      'ember-trail': ctx({
        github: github({
          commitsByDay: Object.fromEntries(
            Array.from({ length: 11 }, (_, i) => [daysAgoISO(i), 1])
          ),
        }),
      }),
      'field-burst': ctx({ github: github({ commitsByDay: { [daysAgoISO(0)]: 8 } }) }),
      'survey-stake': ctx({ github: github({ totalCommits: 137 }) }),
    }

    for (const [id, unlockCtx] of Object.entries(unlockingCtxs)) {
      const def = item(id)
      // dew-vial relies on a mockReturnValueOnce queued above; re-queue it
      // immediately before calling unlocked/progress so both calls see it.
      if (id === 'dew-vial') {
        const dates = [0, 1, 2, 3, 4, 5, 6].map(daysAgoISO)
        mockGetAllContent.mockReturnValue(contentWithDates(dates))
      }
      expect(def.unlocked(unlockCtx)).toBe(true)
      expect(def.progress(unlockCtx)).toBe(1)
    }
  })

  describe('spore-jar', () => {
    it('unlocks at exactly 5 notes, not before', () => {
      const def = item('spore-jar')
      expect(def.unlocked(ctx({ stats: stats({ noteCount: 4 }) }))).toBe(false)
      expect(def.unlocked(ctx({ stats: stats({ noteCount: 5 }) }))).toBe(true)
      expect(def.progress(ctx({ stats: stats({ noteCount: 4 }) }))).toBeCloseTo(0.8)
    })
  })

  describe('hand-lens', () => {
    it('unlocks at exactly 5 backlinks on a single note, not before', () => {
      const def = item('hand-lens')
      expect(def.unlocked(ctx({ stats: stats({ maxBacklinksOnSingleNote: 4 }) }))).toBe(false)
      expect(def.unlocked(ctx({ stats: stats({ maxBacklinksOnSingleNote: 5 }) }))).toBe(true)
      expect(def.progress(ctx({ stats: stats({ maxBacklinksOnSingleNote: 4 }) }))).toBeCloseTo(0.8)
    })
  })

  describe('trowel', () => {
    it('unlocks at the first published project, not before', () => {
      const def = item('trowel')
      expect(def.unlocked(ctx({ stats: stats({ projectCount: 0 }) }))).toBe(false)
      expect(def.progress(ctx({ stats: stats({ projectCount: 0 }) }))).toBe(0)
      expect(def.unlocked(ctx({ stats: stats({ projectCount: 1 }) }))).toBe(true)
    })
  })

  describe('field-ledger', () => {
    it('unlocks at exactly 25 notes, not before', () => {
      const def = item('field-ledger')
      expect(def.unlocked(ctx({ stats: stats({ noteCount: 24 }) }))).toBe(false)
      expect(def.unlocked(ctx({ stats: stats({ noteCount: 25 }) }))).toBe(true)
      expect(def.progress(ctx({ stats: stats({ noteCount: 24 }) }))).toBeCloseTo(24 / 25)
    })
  })

  describe('brass-compass', () => {
    it('unlocks at exactly 10 distinct tags, not before', () => {
      const def = item('brass-compass')
      expect(def.unlocked(ctx({ stats: stats({ tagCount: 9 }) }))).toBe(false)
      expect(def.unlocked(ctx({ stats: stats({ tagCount: 10 }) }))).toBe(true)
      expect(def.progress(ctx({ stats: stats({ tagCount: 9 }) }))).toBeCloseTo(0.9)
    })
  })

  describe('pressed-frond', () => {
    it('unlocks only once a note is evergreen, with partial credit for budding', () => {
      const def = item('pressed-frond')
      expect(
        def.unlocked(ctx({ stats: stats({ maturityCounts: { seedling: 1, budding: 0, evergreen: 0 } }) }))
      ).toBe(false)
      expect(
        def.progress(ctx({ stats: stats({ maturityCounts: { seedling: 1, budding: 0, evergreen: 0 } }) }))
      ).toBe(0)
      expect(
        def.progress(ctx({ stats: stats({ maturityCounts: { seedling: 0, budding: 1, evergreen: 0 } }) }))
      ).toBe(0.5)
      expect(
        def.unlocked(ctx({ stats: stats({ maturityCounts: { seedling: 0, budding: 0, evergreen: 1 } }) }))
      ).toBe(true)
    })
  })

  describe('dew-vial', () => {
    it('is locked with fewer than 7 consecutive days, using GitHub commit days', () => {
      const def = item('dew-vial')
      mockGetAllContent.mockReturnValue([])
      const c = ctx({
        github: github({
          commitsByDay: {
            [daysAgoISO(0)]: 1,
            [daysAgoISO(1)]: 1,
            [daysAgoISO(2)]: 1,
          },
        }),
      })
      expect(def.unlocked(c)).toBe(false)
    })

    it('unlocks with 7 consecutive days ending today, combining note dates and commit days, for the owner', () => {
      const def = item('dew-vial')
      mockGetAllContent.mockReturnValue(
        contentWithDates([daysAgoISO(0), daysAgoISO(1), daysAgoISO(2)])
      )
      const c = ctx({
        isOwner: true,
        github: github({
          commitsByDay: {
            [daysAgoISO(3)]: 1,
            [daysAgoISO(4)]: 1,
            [daysAgoISO(5)]: 1,
            [daysAgoISO(6)]: 1,
          },
        }),
      })
      expect(def.unlocked(c)).toBe(true)
      expect(def.progress(c)).toBe(1)
    })

    it('gives partial progress credit for the longest run on record when not unlocked, for the owner', () => {
      const def = item('dew-vial')
      // A 3-day run far in the past, nowhere near "today".
      mockGetAllContent.mockReturnValue(
        contentWithDates([daysAgoISO(40), daysAgoISO(41), daysAgoISO(42)])
      )
      const c = ctx({ isOwner: true })
      expect(def.unlocked(c)).toBe(false)
      expect(def.progress(c)).toBeCloseTo(3 / 7)
    })

    it('does not throw and returns false/0 when github is null and there are no active days', () => {
      const def = item('dew-vial')
      mockGetAllContent.mockReturnValue([])
      const c = ctx({ github: null })
      expect(() => def.unlocked(c)).not.toThrow()
      expect(() => def.progress(c)).not.toThrow()
      expect(def.unlocked(c)).toBe(false)
      expect(def.progress(c)).toBe(0)
    })

    it('longestConsecutiveRun tracks the LONGEST run, not the most recent, when an earlier run is longer', () => {
      // Kills the `current > best` -> `true` mutant (items.ts:79) and the
      // `sorted[i] !== sorted[i-1]` gap-detection mutants (items.ts:76): a
      // naive "always overwrite best with current" implementation would
      // report the shorter, more recent run (2 days) instead of the true
      // longest run (5 days) found earlier and further in the past.
      const def = item('dew-vial')
      mockGetAllContent.mockReturnValue(
        contentWithDates([
          // An earlier, longer run: 5 consecutive days, far enough in the
          // past that it cannot also read as "ending today".
          daysAgoISO(30),
          daysAgoISO(31),
          daysAgoISO(32),
          daysAgoISO(33),
          daysAgoISO(34),
          // A gap, then a shorter, more recent run of 2 days.
          daysAgoISO(0),
          daysAgoISO(1),
        ])
      )
      const c = ctx({ isOwner: true })
      expect(def.unlocked(c)).toBe(false) // neither run reaches 7
      // Progress should reflect the longer 5-day run (5/7), not the more
      // recent 2-day run (2/7).
      expect(def.progress(c)).toBeCloseTo(5 / 7)
    })

    it('longestConsecutiveRun is unaffected by a duplicate date entry (two notes published the same day)', () => {
      // Kills the `sorted[i] !== sorted[i-1]` equality/boolean mutants:
      // a duplicate day must neither extend the run nor spuriously reset it.
      const def = item('dew-vial')
      mockGetAllContent.mockReturnValue(
        contentWithDates([
          daysAgoISO(10),
          daysAgoISO(10), // duplicate of the same day
          daysAgoISO(11),
          daysAgoISO(12),
        ])
      )
      const c = ctx({ isOwner: true })
      // The true run length is 3 (days 10, 11, 12), not 4 and not broken by
      // the duplicate.
      expect(def.progress(c)).toBeCloseTo(3 / 7)
    })

    it('excludes a content item with no date, and one with an unparsable date, without throwing or corrupting the active-days set', () => {
      // Kills items.ts:101 (`!item.date` continue -> false) and items.ts:103
      // (`!Number.isNaN(t.getTime())` -> true). A leaked bad date would
      // either crash `toISOString()` on an Invalid Date or silently pollute
      // the active-days set, changing streak progress it should not affect.
      const def = item('dew-vial')
      mockGetAllContent.mockReturnValue([
        ...contentWithDates([daysAgoISO(0), daysAgoISO(1), daysAgoISO(2)]),
        // A note with no date at all.
        {
          title: 'no-date-note',
          date: '' as unknown as string,
          description: '',
          tags: [],
          type: 'note',
          slug: 'no-date-note',
          collection: 'notes',
          href: '/notes/no-date-note',
        },
        // A note with an unparsable date string.
        {
          title: 'bad-date-note',
          date: 'not-a-real-date',
          description: '',
          tags: [],
          type: 'note',
          slug: 'bad-date-note',
          collection: 'notes',
          href: '/notes/bad-date-note',
        },
      ])
      const c = ctx({ isOwner: true })
      expect(() => def.unlocked(c)).not.toThrow()
      expect(() => def.progress(c)).not.toThrow()
      // Only the 3 valid dates should count toward the streak/run.
      expect(def.progress(c)).toBeCloseTo(3 / 7)
    })

    // --- THE LEAK REGRESSION TEST -------------------------------------
    //
    // This is the exact bug class T9 exists to close: `getActiveDays()`
    // used to call `getAllContent()` unconditionally, so a stranger's Dew
    // Vial streak silently absorbed the site owner's local note-publish
    // dates. Prove it cannot happen any more: a non-owner context (the
    // shape every real non-owner creature is built from, see
    // `repo-creature.ts`) must produce the exact same streak/progress
    // whether or not the owner's content mock returns real dates.
    it('never lets owner note dates leak into a non-owner (isOwner: false) context', () => {
      const def = item('dew-vial')
      // The owner's "local garden": a real, currently-active 7 day streak
      // that would unlock Dew Vial outright if it leaked through.
      mockGetAllContent.mockReturnValue(
        contentWithDates([
          daysAgoISO(0),
          daysAgoISO(1),
          daysAgoISO(2),
          daysAgoISO(3),
          daysAgoISO(4),
          daysAgoISO(5),
          daysAgoISO(6),
        ])
      )

      // A stranger's creature: no commit activity at all, isOwner: false,
      // exactly the shape composeCreatureState builds for anyone who is
      // not the site owner.
      const strangerCtx = ctx({ isOwner: false, github: null })

      expect(def.unlocked(strangerCtx)).toBe(false)
      expect(def.progress(strangerCtx)).toBe(0)

      // Sanity check on the fixture itself: the exact same mocked note
      // dates DO unlock Dew Vial once isOwner is true, proving the
      // difference above is caused by the isOwner gate and not by some
      // other accident (e.g. the mock silently returning nothing).
      const ownerCtx = ctx({ isOwner: true, github: null })
      expect(def.unlocked(ownerCtx)).toBe(true)
      expect(def.progress(ownerCtx)).toBe(1)
    })
  })

  describe('commit items never depend on ctx.isOwner or ctx.stats', () => {
    it('ember-trail, field-burst, and survey-stake read identically for owner and non-owner given the same github data', () => {
      const gh = github({
        commitsByDay: Object.fromEntries(
          Array.from({ length: 11 }, (_, i) => [daysAgoISO(i), 3])
        ),
        totalCommits: 200,
      })
      for (const def of COMMIT_ITEMS) {
        const ownerResult = {
          unlocked: def.unlocked(ctx({ isOwner: true, github: gh })),
          progress: def.progress(ctx({ isOwner: true, github: gh })),
        }
        const strangerResult = {
          unlocked: def.unlocked(ctx({ isOwner: false, github: gh })),
          progress: def.progress(ctx({ isOwner: false, github: gh })),
        }
        expect(strangerResult).toEqual(ownerResult)
      }
    })

    it('every commit item is false/0 with no github data, regardless of isOwner', () => {
      for (const def of COMMIT_ITEMS) {
        expect(def.unlocked(ctx({ isOwner: true, github: null }))).toBe(false)
        expect(def.progress(ctx({ isOwner: true, github: null }))).toBe(0)
        expect(def.unlocked(ctx({ isOwner: false, github: null }))).toBe(false)
        expect(def.progress(ctx({ isOwner: false, github: null }))).toBe(0)
      }
    })
  })

  describe('ember-trail', () => {
    it('unlocks at 11 consecutive github commit days ending today, not before', () => {
      const def = item('ember-trail')
      const tenDays = ctx({
        github: github({
          commitsByDay: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [daysAgoISO(i), 1])
          ),
        }),
      })
      const elevenDays = ctx({
        github: github({
          commitsByDay: Object.fromEntries(
            Array.from({ length: 11 }, (_, i) => [daysAgoISO(i), 1])
          ),
        }),
      })
      expect(def.unlocked(tenDays)).toBe(false)
      expect(def.unlocked(elevenDays)).toBe(true)
      expect(def.progress(elevenDays)).toBe(1)
    })

    it('does not count note-publish dates even when isOwner is true', () => {
      const def = item('ember-trail')
      mockGetAllContent.mockReturnValue(
        contentWithDates(Array.from({ length: 11 }, (_, i) => daysAgoISO(i)))
      )
      const c = ctx({ isOwner: true, github: null })
      expect(def.unlocked(c)).toBe(false)
      expect(def.progress(c)).toBe(0)
    })

    it('gives fractional progress credit proportional to the longest run when not unlocked', () => {
      // Kills items.ts:635 (`longestConsecutiveRun(days) / TARGET` mutated
      // to `*`). A 3-day run against an 11-day target should read as
      // roughly 0.27, never 1: multiplying instead of dividing would push
      // any nonzero run straight to a clamped 1.
      const def = item('ember-trail')
      const c = ctx({
        github: github({
          commitsByDay: {
            [daysAgoISO(20)]: 1,
            [daysAgoISO(21)]: 1,
            [daysAgoISO(22)]: 1,
          },
        }),
      })
      expect(def.unlocked(c)).toBe(false)
      expect(def.progress(c)).toBeCloseTo(3 / 11)
      expect(def.progress(c)).toBeLessThan(1)
    })
  })

  describe('field-burst', () => {
    it('unlocks at exactly 8 commits in a single day, not before', () => {
      const def = item('field-burst')
      expect(
        def.unlocked(ctx({ github: github({ commitsByDay: { [daysAgoISO(0)]: 7 } }) }))
      ).toBe(false)
      expect(
        def.unlocked(ctx({ github: github({ commitsByDay: { [daysAgoISO(0)]: 8 } }) }))
      ).toBe(true)
      expect(
        def.progress(ctx({ github: github({ commitsByDay: { [daysAgoISO(0)]: 7 } }) }))
      ).toBeCloseTo(7 / 8)
    })

    it('finds the true maximum across multiple days, not just the last day iterated', () => {
      // Kills items.ts:132 (`count > max` -> `true`, in maxCommitsInADay):
      // unconditionally overwriting `max` with every count would report
      // whichever day happens to be enumerated last, not the true peak.
      const def = item('field-burst')
      const c = ctx({
        github: github({
          commitsByDay: {
            [daysAgoISO(5)]: 8, // the true max, not last in iteration order
            [daysAgoISO(4)]: 2,
            [daysAgoISO(3)]: 1,
            [daysAgoISO(0)]: 3, // last inserted, smaller than the max
          },
        }),
      })
      expect(def.unlocked(c)).toBe(true)
      expect(def.progress(c)).toBe(1)
    })
  })

  describe('survey-stake', () => {
    it('unlocks at exactly 137 total commits, not before', () => {
      const def = item('survey-stake')
      expect(def.unlocked(ctx({ github: github({ totalCommits: 136 }) }))).toBe(false)
      expect(def.unlocked(ctx({ github: github({ totalCommits: 137 }) }))).toBe(true)
      expect(def.progress(ctx({ github: github({ totalCommits: 136 }) }))).toBeCloseTo(
        136 / 137
      )
    })
  })

  // --- End-to-end version of the leak regression, through the same
  // `composeCreatureState()` path `api/creature/route.ts` actually calls for
  // any handle that is not the site owner. ---------------------------------
  describe('composeCreatureState (non-owner creature)', () => {
    it('computes a non-owner creature whose garden numbers are all zero and whose items contain no garden items, even when the owner has a real, currently-unlockable garden', () => {
      // The owner's real local garden: a 30 day note-publish streak, plenty
      // to unlock Dew Vial outright if the mock leaked through. This is the
      // "hot" fixture; the assertions below prove none of it reaches a
      // stranger's creature.
      mockGetAllContent.mockReturnValue(
        contentWithDates(Array.from({ length: 30 }, (_, i) => daysAgoISO(i)))
      )

      // A stranger's GitHub-only creature: exactly what `api/creature/route.ts`
      // builds for `?user=<not the owner>`, fed the same fully-zeroed
      // `emptyGardenStats()` the real non-owner code path uses.
      const nonOwnerState = composeCreatureState(
        emptyGardenStats(),
        github({ commitsByDay: { [daysAgoISO(0)]: 3 }, totalCommits: 50 }),
        { includeItems: true, isOwner: false }
      )

      expect(nonOwnerState.stats.noteCount).toBe(0)
      expect(nonOwnerState.stats.projectCount).toBe(0)
      expect(nonOwnerState.stats.totalWords).toBe(0)
      expect(nonOwnerState.stats.tagCount).toBe(0)
      expect(nonOwnerState.stats.maxBacklinksOnSingleNote).toBe(0)
      expect(nonOwnerState.stats.maturityCounts).toEqual({
        seedling: 0,
        budding: 0,
        evergreen: 0,
      })

      const gardenItemIds = new Set(GARDEN_ITEMS.map((d) => d.id))
      for (const itemState of nonOwnerState.items) {
        expect(gardenItemIds.has(itemState.def.id)).toBe(false)
      }
      expect(nonOwnerState.items.length).toBe(COMMIT_ITEMS.length)
    })
  })
})
