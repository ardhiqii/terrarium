import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheClearAll } from './api-cache'
import { opaqueReferenceId } from '../sync/product-snapshot'
import type { RepoMeta } from './creature-route-shared'

/**
 * The server lookup for a dressed repository. The stores are mocked: the point
 * is the ORDER of the checks (nothing about the collection is read until the
 * repo is known public and its owner opted in) and the never-throw contract.
 */

const badgeGet = vi.fn()
const productGet = vi.fn()

vi.mock('../sync/repo-badge-store', () => ({
  getRepoBadgeStore: () => ({ get: badgeGet }),
}))
vi.mock('../sync/product-store', () => ({
  getProductStore: () => ({ get: productGet }),
}))

const NOW = '2026-11-04T00:00:00.000Z'
const DRESSED_SNAPSHOT = {
  collection: [
    { referenceId: opaqueReferenceId('r1'), companionId: 'pikachu-family', acquiredAt: NOW, acquisition: 'encounter' },
  ],
  companions: [{ companionId: 'pikachu-family', xp: 10 }],
  assignments: [{ repositoryId: '555', referenceId: 'r1', companionId: 'pikachu-family', assignedAt: NOW }],
}

const publicRepo: RepoMeta = {
  language: 'TypeScript',
  createdAt: null,
  pushedAt: null,
  sizeKb: null,
  id: '555',
  ownerId: 42,
  isPrivate: false,
}

async function lookup(meta: RepoMeta | null) {
  const { lookupDressedCompanion } = await import('./dressed-repo-lookup')
  return lookupDressedCompanion(meta)
}

beforeEach(() => {
  cacheClearAll()
  badgeGet.mockReset()
  productGet.mockReset()
})

afterEach(() => {
  cacheClearAll()
})

describe('lookupDressedCompanion', () => {
  it('reads nothing for a private repository, or one whose visibility is unknown', async () => {
    for (const isPrivate of [true, null, undefined]) {
      expect(await lookup({ ...publicRepo, isPrivate })).toEqual({ optedIn: false, dressed: null })
    }
    expect(await lookup(null)).toEqual({ optedIn: false, dressed: null })
    expect(badgeGet).not.toHaveBeenCalled()
    expect(productGet).not.toHaveBeenCalled()
  })

  it('reads nothing without a repository id or owner id', async () => {
    expect((await lookup({ ...publicRepo, id: null })).dressed).toBeNull()
    expect((await lookup({ ...publicRepo, ownerId: null })).dressed).toBeNull()
    expect(badgeGet).not.toHaveBeenCalled()
  })

  it('never reads the snapshot when the owner has not opted in', async () => {
    badgeGet.mockResolvedValue(null)
    expect(await lookup(publicRepo)).toEqual({ optedIn: false, dressed: null })
    expect(badgeGet).toHaveBeenCalledWith(42)
    expect(productGet).not.toHaveBeenCalled()
  })

  it('returns the dressed companion for an opted-in owner, keyed by the owner id', async () => {
    badgeGet.mockResolvedValue({ handle: 'octo', updatedAt: NOW })
    productGet.mockResolvedValue(DRESSED_SNAPSHOT)
    const result = await lookup(publicRepo)
    expect(result.optedIn).toBe(true)
    expect(result.dressed?.companionId).toBe('pikachu-family')
    expect(productGet).toHaveBeenCalledWith(42)
  })

  it('says opted in but not dressed for an undressed repository', async () => {
    badgeGet.mockResolvedValue({ handle: 'octo', updatedAt: NOW })
    productGet.mockResolvedValue(DRESSED_SNAPSHOT)
    expect(await lookup({ ...publicRepo, id: '999' })).toEqual({ optedIn: true, dressed: null })
  })

  it('caches a result briefly, so a burst of badge views reads the store once', async () => {
    badgeGet.mockResolvedValue({ handle: 'octo', updatedAt: NOW })
    productGet.mockResolvedValue(DRESSED_SNAPSHOT)
    await lookup(publicRepo)
    await lookup(publicRepo)
    expect(badgeGet).toHaveBeenCalledTimes(1)
  })

  it('answers "not dressed" on a store failure, and does not cache the failure', async () => {
    badgeGet.mockRejectedValueOnce(new Error('db down'))
    expect(await lookup(publicRepo)).toEqual({ optedIn: false, dressed: null })
    badgeGet.mockResolvedValue({ handle: 'octo', updatedAt: NOW })
    productGet.mockResolvedValue(DRESSED_SNAPSHOT)
    expect((await lookup(publicRepo)).dressed).not.toBeNull()
  })
})
