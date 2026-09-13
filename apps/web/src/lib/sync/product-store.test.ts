import { describe, expect, it } from 'vitest'
import { ProductSqliteStore } from './product-store'
import { buildProductSnapshot } from './product-snapshot'
import { createCompanionCatalog, type CompanionCatalog } from '../game/companion-catalog'
import { createProductState } from '../game/product-state'
import { createEncounterState } from '../game/encounters'
import { createGuestProfile } from '../game/guest-profile'
import { PROTOTYPE_COMPANION_CATALOG } from '../game/companion-catalog'

function baseSnapshot() {
  const profile = createGuestProfile({
    guestId: 'guest-abc',
    starterCompanionId: 'pikachu-family',
    now: '2026-09-12T00:00:00.000Z',
  })
  const catalog: CompanionCatalog = PROTOTYPE_COMPANION_CATALOG
  const state = createProductState(profile, { events: [] }, createEncounterState(), catalog)
  return buildProductSnapshot(state, '2026-09-12T00:00:00.000Z')
}

describe('ProductSqliteStore', () => {
  it('round-trips a put then get on a fresh in-memory store', async () => {
    const store = new ProductSqliteStore(':memory:')
    const snapshot = baseSnapshot()
    await store.put('octocat', snapshot, snapshot.updatedAt)
    const fetched = await store.get('octocat')
    expect(fetched).toEqual(snapshot)
  })

  it('returns null for a handle that has never synced', async () => {
    const store = new ProductSqliteStore(':memory:')
    const fetched = await store.get('nobody')
    expect(fetched).toBeNull()
  })

  it('upserts and forgets a handle', async () => {
    const store = new ProductSqliteStore(':memory:')
    const snapshot = baseSnapshot()
    await store.put('octocat', snapshot, snapshot.updatedAt)
    await store.remove('octocat')
    expect(await store.get('octocat')).toBeNull()
  })
})
