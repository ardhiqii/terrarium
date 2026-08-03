import { describe, expect, it } from 'vitest'
import { SqliteSyncStore } from './sqlite-store'
import type { SyncedUser } from './types'

function fakeUser(handle: string, overrides: Partial<SyncedUser> = {}): SyncedUser {
  return {
    handle,
    githubId: 12345,
    avatarUrl: 'https://example.com/avatar.png',
    snapshot: {
      schemaVersion: 1,
      totalXp: 100,
      stage: 'sporeling',
      stageIndex: 1,
      noteCount: 1,
      projectCount: 0,
      totalWords: 50,
      tagCount: 1,
      companions: [],
      unlockedItemIds: [],
      generatedAt: '2024-01-01T00:00:00.000Z',
    },
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('SqliteSyncStore', () => {
  it('round-trips a put then get, on a fresh in-memory database', async () => {
    const store = new SqliteSyncStore(':memory:')
    const user = fakeUser('octocat')
    await store.put(user)
    const fetched = await store.get('octocat')
    expect(fetched).toEqual(user)
  })

  it('returns null for a handle that has never synced', async () => {
    const store = new SqliteSyncStore(':memory:')
    const fetched = await store.get('nobody')
    expect(fetched).toBeNull()
  })

  it('treats handles as case-insensitive: Torvalds and torvalds are one row', async () => {
    const store = new SqliteSyncStore(':memory:')
    await store.put(fakeUser('Torvalds'))
    await store.put(fakeUser('torvalds', { githubId: 999 }))

    const viaLower = await store.get('torvalds')
    const viaMixed = await store.get('TORVALDS')

    expect(viaLower).not.toBeNull()
    expect(viaMixed).not.toBeNull()
    expect(viaLower?.githubId).toBe(999) // second put replaced the first
    expect(viaLower?.handle).toBe(viaMixed?.handle)

    const many = await store.getMany(['torvalds'])
    expect(many).toHaveLength(1) // never became two rows
  })

  it('put replaces an existing row rather than erroring on conflict', async () => {
    const store = new SqliteSyncStore(':memory:')
    await store.put(fakeUser('octocat', { updatedAt: '2024-01-01T00:00:00.000Z' }))
    await store.put(fakeUser('octocat', { updatedAt: '2024-02-01T00:00:00.000Z' }))
    const fetched = await store.get('octocat')
    expect(fetched?.updatedAt).toBe('2024-02-01T00:00:00.000Z')
  })

  it('getMany returns only the handles that have synced, skipping the rest', async () => {
    const store = new SqliteSyncStore(':memory:')
    await store.put(fakeUser('alice'))
    const result = await store.getMany(['alice', 'bob', 'carol'])
    expect(result.map((u) => u.handle)).toEqual(['alice'])
  })

  it('remove forgets a user entirely', async () => {
    const store = new SqliteSyncStore(':memory:')
    await store.put(fakeUser('octocat'))
    await store.remove('octocat')
    const fetched = await store.get('octocat')
    expect(fetched).toBeNull()
  })

  it('remove on a handle that never synced does not throw', async () => {
    const store = new SqliteSyncStore(':memory:')
    await expect(store.remove('nobody')).resolves.toBeUndefined()
  })
})
