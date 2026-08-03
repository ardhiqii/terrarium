import { describe, it, expect } from 'vitest'
import { buildLeaderboardEntries } from './leaderboard'
import type { SyncedUser } from './types'

function makeUser(handle: string, totalXp: number, overrides: Partial<SyncedUser> = {}): SyncedUser {
  return {
    handle,
    githubId: 1,
    avatarUrl: null,
    snapshot: {
      schemaVersion: 1,
      totalXp,
      stage: 'sporeling',
      stageIndex: 1,
      noteCount: 0,
      projectCount: 0,
      totalWords: 0,
      tagCount: 0,
      companions: [],
      unlockedItemIds: [],
      generatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('buildLeaderboardEntries', () => {
  it('sorts descending by total xp', () => {
    const users = [makeUser('low', 100), makeUser('high', 900), makeUser('mid', 500)]
    const entries = buildLeaderboardEntries(users, null)
    expect(entries.map((e) => e.handle)).toEqual(['high', 'mid', 'low'])
  })

  it('marks the viewer row, case-insensitively', () => {
    const users = [makeUser('Alice', 100), makeUser('bob', 200)]
    const entries = buildLeaderboardEntries(users, 'ALICE')
    expect(entries.find((e) => e.handle === 'Alice')?.isViewer).toBe(true)
    expect(entries.find((e) => e.handle === 'bob')?.isViewer).toBe(false)
  })

  it('marks no row as the viewer when signed out', () => {
    const users = [makeUser('alice', 100)]
    const entries = buildLeaderboardEntries(users, null)
    expect(entries.every((e) => !e.isViewer)).toBe(true)
  })

  it('derives companionCount from the companions array length', () => {
    const user = makeUser('alice', 100, {
      snapshot: {
        ...makeUser('alice', 100).snapshot,
        companions: [
          { stage: 'sporeling', stageIndex: 1 },
          { stage: 'mossling', stageIndex: 2 },
        ],
      },
    })
    const [entry] = buildLeaderboardEntries([user], null)
    expect(entry.companionCount).toBe(2)
  })

  it('returns [] for an empty input', () => {
    expect(buildLeaderboardEntries([], 'alice')).toEqual([])
  })
})
