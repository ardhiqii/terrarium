import { describe, it, expect, beforeEach } from 'vitest'
import { InMemorySyncStore } from './runtime'
import type { SyncedUser } from './types'

function makeUser(overrides: Partial<SyncedUser> = {}): SyncedUser {
  return {
    handle: 'octocat',
    githubId: 1,
    avatarUrl: null,
    snapshot: {
      schemaVersion: 1,
      totalXp: 100,
      stage: 'sporeling',
      stageIndex: 1,
      noteCount: 1,
      projectCount: 0,
      totalWords: 100,
      tagCount: 1,
      companions: [],
      unlockedItemIds: [],
      generatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('InMemorySyncStore', () => {
  let store: InMemorySyncStore

  beforeEach(() => {
    store = new InMemorySyncStore()
  })

  it('returns null for a handle that has never synced', async () => {
    expect(await store.get('nobody')).toBeNull()
  })

  it('round-trips a put/get', async () => {
    const user = makeUser()
    await store.put(user)
    expect(await store.get('octocat')).toEqual(user)
  })

  it('matches handles case-insensitively, both on write and read', async () => {
    const user = makeUser({ handle: 'Torvalds' })
    await store.put(user)
    expect(await store.get('torvalds')).toEqual(user)
    expect(await store.get('TORVALDS')).toEqual(user)
  })

  it('put replaces an existing snapshot for the same handle', async () => {
    await store.put(makeUser({ snapshot: { ...makeUser().snapshot, totalXp: 100 } }))
    await store.put(makeUser({ snapshot: { ...makeUser().snapshot, totalXp: 500 } }))
    const result = await store.get('octocat')
    expect(result?.snapshot.totalXp).toBe(500)
  })

  it('getMany returns only the handles that have synced, skipping the rest', async () => {
    await store.put(makeUser({ handle: 'alice' }))
    await store.put(makeUser({ handle: 'bob' }))
    const result = await store.getMany(['alice', 'nobody', 'BOB', 'ghost'])
    expect(result.map((u) => u.handle).sort()).toEqual(['alice', 'bob'])
  })

  it('remove forgets a user entirely', async () => {
    await store.put(makeUser())
    await store.remove('octocat')
    expect(await store.get('octocat')).toBeNull()
  })

  it('seedSync writes synchronously, for demo/test data setup', async () => {
    const user = makeUser({ handle: 'seeded' })
    store.seedSync(user)
    await expect(store.get('seeded')).resolves.toEqual(user)
  })
})
