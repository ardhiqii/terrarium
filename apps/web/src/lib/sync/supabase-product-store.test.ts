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

  it('lowercases handles when deleting a product snapshot', async () => {
    const eq = vi.fn().mockResolvedValue({ error: null })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue({ eq }) }),
    } as never)

    await new SupabaseProductStore().remove('Torvalds')

    expect(eq).toHaveBeenCalledWith('handle', 'torvalds')
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
    const putQuery = { upsert: put }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(putQuery) } as never)
    const store = new SupabaseProductStore()
    const original = snapshot()

    await store.put('Torvalds', original, original.updatedAt)
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'torvalds', snapshot_json: original }),
      { onConflict: 'handle' },
    )

    const maybeSingle = vi.fn()
      .mockResolvedValueOnce({ data: { handle: 'torvalds', snapshot_json: original, updated_at: original.updatedAt }, error: null })
      .mockResolvedValueOnce({ data: { handle: 'torvalds', snapshot_json: JSON.stringify(original), updated_at: original.updatedAt }, error: null })
    const getQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(getQuery) } as never)
    await expect(store.get('TORVALDS')).resolves.toEqual(original)
    await expect(store.get('torvalds')).resolves.toEqual(original)
  })

  it('returns null for a missing row and surfaces database errors', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const getQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle,
    }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(getQuery) } as never)
    await expect(new SupabaseProductStore().get('missing')).resolves.toBeNull()

    const errorQuery = { upsert: vi.fn().mockResolvedValue({ error: { message: 'offline' } }) }
    mockedGetClient.mockReturnValue({ from: vi.fn().mockReturnValue(errorQuery) } as never)
    const value = snapshot()
    await expect(new SupabaseProductStore().put('Torvalds', value, value.updatedAt)).rejects.toThrow(
      'Supabase product_snapshots.put failed: offline',
    )
  })

  it('reports delete failures', async () => {
    const eq = vi.fn().mockResolvedValue({ error: { message: 'denied' } })
    mockedGetClient.mockReturnValue({
      from: vi.fn().mockReturnValue({ delete: vi.fn().mockReturnValue({ eq }) }),
    } as never)
    await expect(new SupabaseProductStore().remove('Torvalds')).rejects.toThrow(
      'Supabase product_snapshots.remove failed: denied',
    )
  })
})
