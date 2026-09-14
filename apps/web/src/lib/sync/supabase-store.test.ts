import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseAdminClient } from './supabase-client'
import { SupabaseSyncStore } from './supabase-store'
import type { SyncedUser } from './types'

vi.mock('./supabase-client', () => ({
  getSupabaseAdminClient: vi.fn(),
}))

const mockedGetClient = vi.mocked(getSupabaseAdminClient)

function fakeUser(handle: string): SyncedUser {
  return {
    handle,
    githubId: 123,
    avatarUrl: null,
    snapshot: {
      schemaVersion: 1,
      totalXp: 10,
      stage: 'sporeling',
      stageIndex: 1,
      noteCount: 0,
      projectCount: 0,
      totalWords: 0,
      tagCount: 0,
      companions: [],
      unlockedItemIds: [],
      generatedAt: '2024-01-01T00:00:00.000Z',
    },
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
}

describe('SupabaseSyncStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lowercases handles when writing', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ upsert }),
    } as never)

    await new SupabaseSyncStore().put(fakeUser('Torvalds'))

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'torvalds' }),
      { onConflict: 'handle' },
    )
  })

  it('round-trips a row and returns null when no row exists', async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({
        data: {
          handle: 'torvalds',
          github_id: 123,
          avatar_url: null,
          snapshot_json: fakeUser('torvalds').snapshot,
          updated_at: '2024-01-01T00:00:00.000Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) } as never)
    const store = new SupabaseSyncStore()

    await expect(store.get('TORVALDS')).resolves.toMatchObject({
      handle: 'torvalds',
      githubId: 123,
      snapshot: { totalXp: 10 },
    })
    await expect(store.get('missing')).resolves.toBeNull()
  })

  it('reads JSON-string snapshots and deduplicates handles for getMany', async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{
          handle: 'torvalds',
          github_id: 123,
          avatar_url: 'avatar',
          snapshot_json: JSON.stringify(fakeUser('torvalds').snapshot),
          updated_at: '2024-01-01T00:00:00.000Z',
        }],
        error: null,
      }),
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) } as never)

    await expect(new SupabaseSyncStore().getMany(['Torvalds', 'torvalds'])).resolves.toMatchObject([
      { handle: 'torvalds', snapshot: { totalXp: 10 } },
    ])
    expect(query.in).toHaveBeenCalledWith('handle', ['torvalds'])
  })

  it('rejects with an operation-specific error for database failures', async () => {
    const query = {
      upsert: vi.fn().mockResolvedValue({ error: { message: 'offline' } }),
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) } as never)

    await expect(new SupabaseSyncStore().put(fakeUser('Torvalds'))).rejects.toThrow(
      'Supabase synced_users.put failed: offline',
    )
  })

  it('removes a normalized handle and reports read failures', async () => {
    const removeEq = vi.fn().mockResolvedValue({ error: null })
    const removeQuery = { delete: vi.fn().mockReturnValue({ eq: removeEq }) }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(removeQuery) } as never)
    await new SupabaseSyncStore().remove('Torvalds')
    expect(removeEq).toHaveBeenCalledWith('handle', 'torvalds')

    const readQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'timeout' } }),
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(readQuery) } as never)
    await expect(new SupabaseSyncStore().get('Torvalds')).rejects.toThrow(
      'Supabase synced_users.get failed: timeout',
    )
  })

  it('does not query Supabase for an empty getMany request', async () => {
    const from = vi.fn()
    mockedGetClient.mockReturnValue({ from } as never)

    await expect(new SupabaseSyncStore().getMany([])).resolves.toEqual([])
    expect(from).not.toHaveBeenCalled()
  })
})
