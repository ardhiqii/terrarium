import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GardenStats, GithubStats } from './types'

/**
 * `getCreatureState()` reads the real garden (`getGardenStats`) and the
 * on-disk GitHub cache (`readGithubCache`) by default. Mock both so this
 * test is deterministic, and so it can directly compare `getCreatureState`'s
 * output against `composeCreatureState`'s output for the same inputs, per
 * the T15 spec's requirement that the two agree since `state.ts` now
 * delegates to `repo-creature.ts`.
 */

const mockStats: GardenStats = {
  noteCount: 4,
  projectCount: 1,
  totalWords: 530,
  resolvedWikilinks: 6,
  backlinksReceived: 9,
  tagCount: 5,
  maturityCounts: { seedling: 2, budding: 2, evergreen: 1 },
  maxBacklinksOnSingleNote: 4,
  firstPublishedAt: '2026-01-01',
  lastPublishedAt: '2026-07-01',
}

vi.mock('./stats', () => ({
  getGardenStats: () => mockStats,
}))

let mockCachedGithub: GithubStats | null = null
vi.mock('./github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github')>()
  return {
    ...actual,
    readGithubCache: () => mockCachedGithub,
  }
})

import { getCreatureState } from './state'
import { composeCreatureState } from './repo-creature'

function github(overrides: Partial<GithubStats> = {}): GithubStats {
  return {
    login: 'owner',
    totalCommits: 12,
    commitsByDay: { '2026-07-01': 4, '2026-07-02': 3 },
    gardenCommitsByDay: { '2026-07-01': 4 },
    currentStreakDays: 2,
    fetchedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  mockCachedGithub = null
})

describe('getCreatureState agreement with composeCreatureState', () => {
  it('matches composeCreatureState(getGardenStats(), github, { includeItems: true }) when github is passed explicitly', () => {
    const gh = github()
    const fromState = getCreatureState(gh)
    const fromCompose = composeCreatureState(mockStats, gh, { includeItems: true })

    expect(fromState.totalXp).toBe(fromCompose.totalXp)
    expect(fromState.stage.id).toBe(fromCompose.stage.id)
    expect(fromState.breakdown).toEqual(fromCompose.breakdown)
    expect(fromState.items.length).toBe(fromCompose.items.length)
    expect(fromState.items.map((i) => i.unlocked)).toEqual(
      fromCompose.items.map((i) => i.unlocked)
    )
  })

  it('falls back to the on-disk GitHub cache when no github argument is given (default null)', () => {
    mockCachedGithub = github({ totalCommits: 999 })
    const fromState = getCreatureState()
    const fromCompose = composeCreatureState(mockStats, mockCachedGithub, {
      includeItems: true,
    })

    expect(fromState.totalXp).toBe(fromCompose.totalXp)
    expect(fromState.github).toEqual(mockCachedGithub)
  })

  it('works with a null cache and null github, producing a valid (if minimal) creature state without throwing', () => {
    mockCachedGithub = null
    expect(() => getCreatureState(null)).not.toThrow()
    const state = getCreatureState(null)
    expect(state.github).toBeNull()
    expect(state.totalXp).toBeGreaterThanOrEqual(0)
  })

  it('includes items (owner path) unlike a bare fallback state', () => {
    const state = getCreatureState(github())
    // The owner path always uses includeItems: true internally.
    expect(state.items.length).toBeGreaterThan(0)
  })
})
