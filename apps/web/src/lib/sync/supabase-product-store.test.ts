import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseAdminClient } from './supabase-client'
import { SupabaseProductStore } from './supabase-product-store'
import { PROTOTYPE_COMPANION_CATALOG } from '../game/companion-catalog'
import { createGuestProfile } from '../game/guest-profile'
import { createProductState } from '../game/product-state'
import { createEncounterState } from '../game/encounters'
import { buildProductSnapshot, type ProductSnapshot } from './product-snapshot'

vi.mock('./supabase-client', () => ({
  getSupabaseAdminClient: vi.fn(),
}))

const mockedGetClient = vi.mocked(getSupabaseAdminClient)

describe('SupabaseProductStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('deletes by immutable GitHub ID', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue({ eq }) }),
    } as never)

    await new SupabaseProductStore().remove(42)

    expect(eq).toHaveBeenCalledWith('github_id', 42)
  })

  it('also removes an old handle-keyed row when deleting an account', async () => {
    const byId = vi.fn().mockResolvedValue({ error: null })
    const legacyIs = vi.fn().mockResolvedValue({ error: null })
    const legacyEq = vi.fn().mockReturnValue({ is: legacyIs })
    const deleteQuery = vi.fn()
      .mockReturnValueOnce({ eq: byId })
      .mockReturnValueOnce({ eq: legacyEq })
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue({ delete: deleteQuery }) } as never)

    await new SupabaseProductStore().remove(42, 'Torvalds')

    expect(byId).toHaveBeenCalledWith('github_id', 42)
    expect(legacyEq).toHaveBeenCalledWith('handle', 'torvalds')
    expect(legacyIs).toHaveBeenCalledWith('github_id', null)
  })

  function snapshot(): ProductSnapshot {
    const now = '2024-01-01T00:00:00.000Z'
    const profile = createGuestProfile({ guestId: 'guest-1', starterCompanionId: 'pikachu-family', now })
    return buildProductSnapshot(
      createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
      now,
    )
  }

  it('serializes a snapshot as JSONB and reads both JSONB and string rows', async () => {
    const put = vi.fn().mockResolvedValue({ error: null })
    const putQuery = { insert: put }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(putQuery) } as never)
    const store = new SupabaseProductStore()
    const original = snapshot()

    await expect(store.put(42, 'Torvalds', original, original.updatedAt, null)).resolves.toBe(true)
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ github_id: 42, handle: 'torvalds', snapshot_json: original }),
    )

    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: { github_id: 42, handle: 'torvalds', snapshot_json: original, updated_at: original.updatedAt }, error: null })
      .mockResolvedValueOnce({ data: { github_id: 42, handle: 'torvalds', snapshot_json: JSON.stringify(original), updated_at: original.updatedAt }, error: null })
    const getQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(getQuery) } as never)
    await expect(store.get(42, 'TORVALDS')).resolves.toEqual(original)
    await expect(store.get(42, 'torvalds')).resolves.toEqual(original)
  })

  it('returns null for a missing row and surfaces database errors', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const getQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(getQuery) } as never)
    await expect(new SupabaseProductStore().get(404, 'missing')).resolves.toBeNull()

    const errorQuery = { insert: vi.fn().mockResolvedValue({ error: { message: 'offline' } }) }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(errorQuery) } as never)
    const value = snapshot()
    await expect(new SupabaseProductStore().put(42, 'Torvalds', value, value.updatedAt, null)).rejects.toThrow(
      'Supabase product_snapshots.put failed: offline',
    )
  })

  it('does not fall back from an immutable ID to a handle already owned by another ID', async () => {
    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) } as never)

    await expect(new SupabaseProductStore().get(42, 'renamed-user')).resolves.toBeNull()
    expect(query.is).toHaveBeenCalledWith('github_id', null)
  })

  it('claims a legacy handle row only when the conditional update returns it', async () => {
    const legacySnapshot = snapshot()
    const byId = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }
    const legacy = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { github_id: null, handle: 'torvalds', snapshot_json: legacySnapshot, updated_at: legacySnapshot.updatedAt },
        error: null,
      }),
    }
    const migrate = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { github_id: 42, handle: 'torvalds', snapshot_json: legacySnapshot, updated_at: legacySnapshot.updatedAt },
        error: null,
      }),
    }
    mockedGetClient.mockReturnValue({
      from: vi.fn()
        .mockReturnValueOnce(byId)
        .mockReturnValueOnce(legacy)
        .mockReturnValueOnce(migrate),
    } as never)

    await expect(new SupabaseProductStore().getRecord(42, 'TORVALDS')).resolves.toEqual({
      githubId: 42,
      handle: 'torvalds',
      snapshot: legacySnapshot,
      updatedAt: legacySnapshot.updatedAt,
    })
    expect(migrate.update).toHaveBeenCalledWith({ github_id: 42 })
    expect(migrate.select).toHaveBeenCalledWith('github_id, handle, snapshot_json, updated_at')
  })

  it('uses the stored timestamp as an optimistic concurrency check', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { github_id: 42 }, error: null })
    const update = vi.fn().mockReturnThis()
    const query = {
      update,
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) } as never)
    const value = snapshot()

    await expect(new SupabaseProductStore().put(42, 'Torvalds', value, value.updatedAt, 'old')).resolves.toBe(true)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ github_id: 42, handle: 'torvalds' }))
  })

  it('reports delete failures', async () => {
    const eq = vi.fn().mockResolvedValue({ error: { message: 'denied' } })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue({ eq }) }),
    } as never)
    await expect(new SupabaseProductStore().remove(42)).rejects.toThrow(
      'Supabase product_snapshots.remove failed: denied',
    )
  })
})
