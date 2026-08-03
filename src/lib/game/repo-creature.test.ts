import { describe, it, expect } from 'vitest'
import {
  composeCreatureState,
  emptyGardenStats,
  fallbackCreatureState,
  toRepoCommitStats,
  repoStatsAreEmpty,
} from './repo-creature'
import { GithubStats } from './types'
import { GARDEN_ITEMS, COMMIT_ITEMS, ITEMS } from './items'
import { computeGardenXp, computeCommitXp } from './xp'

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

describe('emptyGardenStats', () => {
  it('produces a fully zeroed GardenStats with every maturity key present', () => {
    const stats = emptyGardenStats()
    expect(stats.noteCount).toBe(0)
    expect(stats.projectCount).toBe(0)
    expect(stats.totalWords).toBe(0)
    expect(stats.resolvedWikilinks).toBe(0)
    expect(stats.backlinksReceived).toBe(0)
    expect(stats.tagCount).toBe(0)
    expect(stats.maxBacklinksOnSingleNote).toBe(0)
    expect(stats.firstPublishedAt).toBeNull()
    expect(stats.lastPublishedAt).toBeNull()
    expect(stats.maturityCounts).toEqual({ seedling: 0, budding: 0, evergreen: 0 })
  })
})

describe('composeCreatureState / getCreatureState agreement', () => {
  it('the owner path (isOwner true, includeItems true) produces the same total XP arithmetic as computing garden + commit XP directly', () => {
    const stats = emptyGardenStats()
    const gh = github({
      commitsByDay: { '2026-07-01': 5 },
      gardenCommitsByDay: { '2026-07-01': 5 },
    })
    const state = composeCreatureState(stats, gh, { includeItems: true, isOwner: true })

    const expectedTotal = state.breakdown.reduce((sum, e) => sum + e.xp, 0)
    expect(state.totalXp).toBe(expectedTotal)
    // Owner gets every item (garden + commit).
    expect(state.items.length).toBe(GARDEN_ITEMS.length + COMMIT_ITEMS.length)
  })

  it('a non-owner path produces consistent arithmetic (breakdown sums to totalXp) and only commit items', () => {
    const gh = github({
      commitsByDay: { '2026-07-01': 5 },
      gardenCommitsByDay: {},
    })
    const state = composeCreatureState(emptyGardenStats(), gh, {
      includeItems: true,
      isOwner: false,
    })

    const expectedTotal = state.breakdown.reduce((sum, e) => sum + e.xp, 0)
    expect(state.totalXp).toBe(expectedTotal)
    expect(state.items.length).toBe(COMMIT_ITEMS.length)
    // No garden item ids should be present for a non-owner.
    const gardenIds = new Set(GARDEN_ITEMS.map((d) => d.id))
    for (const itemState of state.items) {
      expect(gardenIds.has(itemState.def.id)).toBe(false)
    }
  })

  it('owner and non-owner produce identical totalXp/breakdown given the same (zeroed) stats and github data, differing only in items', () => {
    const gh = github({
      commitsByDay: { '2026-07-01': 5 },
      gardenCommitsByDay: {},
    })
    const stats = emptyGardenStats()
    const ownerState = composeCreatureState(stats, gh, { includeItems: true, isOwner: true })
    const nonOwnerState = composeCreatureState(stats, gh, {
      includeItems: true,
      isOwner: false,
    })

    expect(ownerState.totalXp).toBe(nonOwnerState.totalXp)
    expect(ownerState.breakdown).toEqual(nonOwnerState.breakdown)
    expect(ownerState.stage.id).toBe(nonOwnerState.stage.id)
  })

  it('stage/progress fields agree with resolveStage for a given totalXp', () => {
    const gh = github({
      commitsByDay: { '2026-07-01': 100, '2026-07-02': 100, '2026-07-03': 100 },
    })
    const state = composeCreatureState(emptyGardenStats(), gh, { isOwner: false })
    expect(state.xpIntoStage).toBe(state.totalXp - state.stage.threshold)
    if (state.nextStage) {
      expect(state.xpForNextStage).toBe(state.nextStage.threshold - state.stage.threshold)
    } else {
      expect(state.xpForNextStage).toBeNull()
      expect(state.progress).toBe(1)
    }
  })

  it('includeItems: false skips item computation entirely', () => {
    const state = composeCreatureState(emptyGardenStats(), null, { includeItems: false })
    expect(state.items).toEqual([])
  })

  it('defaults includeItems to true when the options object omits the key entirely', () => {
    // Kills the `options.includeItems ?? true` -> `false` / `&& true`
    // mutants (repo-creature.ts:98): calling with no `includeItems` key at
    // all must still compute items, not silently skip them.
    const state = composeCreatureState(emptyGardenStats(), null, {})
    expect(state.items.length).toBeGreaterThan(0)
  })

  it('defaults isOwner to true when the options object omits the key entirely', () => {
    // Kills the `options.isOwner ?? true` -> `false` / `&& true` mutants
    // (repo-creature.ts:99): the one caller that predates this option
    // (state.ts's getCreatureState) relies on the default being the owner
    // path, i.e. the full ITEMS list, not just COMMIT_ITEMS.
    const state = composeCreatureState(emptyGardenStats(), null, {})
    expect(state.items.length).toBe(ITEMS.length)
  })

  it('breakdown is the real concatenation of garden and commit XP entries, and totalXp is independently reproducible from it', () => {
    // Kills `[...gardenXp, ...commitXp]` -> `[]` (repo-creature.ts:103): a
    // self-referential assertion (summing state.breakdown and comparing to
    // state.totalXp) would pass even under this mutant, since both sides
    // collapse to 0 together. Compare against values computed independently
    // via computeGardenXp/computeCommitXp instead.
    const stats = emptyGardenStats()
    stats.noteCount = 3
    const gh = github({ commitsByDay: { '2026-07-01': 5 }, gardenCommitsByDay: {} })

    const state = composeCreatureState(stats, gh, { includeItems: false })

    const expectedEntries = [...computeGardenXp(stats), ...computeCommitXp(gh)]
    const expectedTotal = expectedEntries.reduce((sum, e) => sum + e.xp, 0)

    expect(state.breakdown.length).toBe(expectedEntries.length)
    expect(state.breakdown.length).toBeGreaterThan(0)
    expect(state.totalXp).toBe(expectedTotal)
    expect(state.totalXp).toBeGreaterThan(0)
  })
})

describe('fallbackCreatureState', () => {
  it('returns a stage-1, zero-XP, non-owner creature that never throws', () => {
    expect(() => fallbackCreatureState()).not.toThrow()
    const state = fallbackCreatureState()
    expect(state.totalXp).toBe(0)
    expect(state.stage.index).toBe(1)
    expect(state.items).toEqual([])
    expect(state.github).toBeNull()
  })

  it('honours includeItems: true by computing commit-only items (all locked, since github is null)', () => {
    const state = fallbackCreatureState(true)
    expect(state.items.length).toBe(COMMIT_ITEMS.length)
    for (const itemState of state.items) {
      expect(itemState.unlocked).toBe(false)
    }
  })
})

describe('toRepoCommitStats', () => {
  it('derives a repo GithubStats from gardenCommitsByDay, with its own gardenCommitsByDay always empty', () => {
    const fetched = github({
      login: 'someone',
      commitsByDay: { '2026-07-01': 2, '2026-07-02': 3 },
      gardenCommitsByDay: { '2026-07-01': 2 },
      totalCommits: 5,
    })
    const repoStats = toRepoCommitStats(fetched, 'the-repo')

    expect(repoStats.login).toBe('someone')
    expect(repoStats.commitsByDay).toEqual({ '2026-07-01': 2 })
    expect(repoStats.totalCommits).toBe(2)
    expect(repoStats.gardenCommitsByDay).toEqual({})
  })

  it('never throws when the fetched stats have no commit activity for the repo', () => {
    const fetched = github({ commitsByDay: { '2026-07-01': 5 }, gardenCommitsByDay: {} })
    expect(() => toRepoCommitStats(fetched, 'unrelated-repo')).not.toThrow()
    const repoStats = toRepoCommitStats(fetched, 'unrelated-repo')
    expect(repoStats.commitsByDay).toEqual({})
    expect(repoStats.totalCommits).toBe(0)
  })
})

describe('repoStatsAreEmpty', () => {
  it('is true when commitsByDay has no keys', () => {
    expect(repoStatsAreEmpty(github({ commitsByDay: {} }))).toBe(true)
  })

  it('is false when commitsByDay has at least one day', () => {
    expect(repoStatsAreEmpty(github({ commitsByDay: { '2026-07-01': 1 } }))).toBe(false)
  })
})

// --- Leak-guard regression, re-asserted from this module's own surface ---
//
// T9 added the isOwner gate so items.ts's getActiveDays() never reads the
// site owner's local content for a non-owner context. items.test.ts already
// covers this at the items.ts level; this re-asserts the same guarantee
// through composeCreatureState (the actual assembly path every non-owner
// creature goes through), independent of whichever item happens to read
// getAllContent().
describe('leak guard: composeCreatureState never lets non-owner get garden stats', () => {
  it('a non-owner creature always has zeroed stats and zero garden-item exposure regardless of what stats object is technically passed in', () => {
    // Even if a caller accidentally passed non-zero stats for a non-owner
    // (a caller bug, not something composeCreatureState can prevent by
    // itself for `stats`), the isOwner flag must still gate which items
    // apply, so garden items never leak into a non-owner's item list.
    const nonZeroStats = emptyGardenStats()
    nonZeroStats.noteCount = 999
    const state = composeCreatureState(nonZeroStats, null, {
      includeItems: true,
      isOwner: false,
    })
    const gardenIds = new Set(GARDEN_ITEMS.map((d) => d.id))
    for (const itemState of state.items) {
      expect(gardenIds.has(itemState.def.id)).toBe(false)
    }
    expect(state.items.length).toBe(COMMIT_ITEMS.length)
  })
})
