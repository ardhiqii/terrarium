import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEncounterState } from './encounters'
import { PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'
import { createGuestProfile } from './guest-profile'
import { createProductState } from './product-state'
import type { CreatureState } from './types'
import { buildProductSnapshot } from '@/lib/sync/product-snapshot'

const mocks = vi.hoisted(() => ({
  session: { handle: 'owner', githubId: 9001, avatarUrl: null as string | null },
  getRecord: vi.fn(),
  put: vi.fn(),
  readGithubCache: vi.fn(),
  migrateLegacyCreature: vi.fn(),
}))

vi.mock('@/lib/sync/session', () => ({
  getSessionProvider: () => ({
    current: async () => mocks.session,
  }),
}))

vi.mock('@/lib/sync/product-store', () => ({
  getProductStore: () => ({
    getRecord: mocks.getRecord,
    put: mocks.put,
  }),
}))

vi.mock('./github', () => ({
  readGithubCache: mocks.readGithubCache,
}))

vi.mock('./companion-migration', () => ({
  migrateLegacyCreature: mocks.migrateLegacyCreature,
}))

function storedSnapshot() {
  const now = '2026-08-28T10:00:00.000Z'
  const profile = createGuestProfile({
    guestId: 'guest-account',
    starterCompanionId: 'pikachu-family',
    now,
  })
  return buildProductSnapshot(
    createProductState(profile, { events: [] }, createEncounterState(), PROTOTYPE_COMPANION_CATALOG),
    now,
  )
}

const legacyState = {} as CreatureState

describe('loadAccountProductState legacy migration gate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'test')
    mocks.session = { handle: 'owner', githubId: 9001, avatarUrl: null }
    mocks.getRecord.mockReset().mockResolvedValue({
      githubId: 9001,
      handle: 'owner',
      snapshot: storedSnapshot(),
      updatedAt: '2026-08-28T10:00:00.000Z',
      version: 'row-1',
    })
    mocks.put.mockReset()
    mocks.readGithubCache.mockReset().mockReturnValue(null)
    mocks.migrateLegacyCreature.mockReset().mockImplementation((state: unknown) => ({
      state,
      changed: false,
    }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the immutable owner ID even when the owner handle was renamed', async () => {
    vi.stubEnv('GITHUB_OWNER_ID', '9001')
    mocks.session = { handle: 'renamed-owner', githubId: 9001, avatarUrl: null }

    const { loadAccountProductState } = await import('./account-product-state')
    const result = await loadAccountProductState(legacyState)

    expect(result.status).toBe('available')
    expect(mocks.readGithubCache).toHaveBeenCalledTimes(1)
    expect(mocks.migrateLegacyCreature).toHaveBeenCalledTimes(1)
  })

  it('does not let a reused handle inherit the owner cache when the ID differs', async () => {
    vi.stubEnv('GITHUB_OWNER_ID', '9001')
    mocks.session = { handle: 'owner', githubId: 9002, avatarUrl: null }

    const { loadAccountProductState } = await import('./account-product-state')
    const result = await loadAccountProductState(legacyState)

    expect(result.status).toBe('available')
    expect(mocks.readGithubCache).not.toHaveBeenCalled()
    expect(mocks.migrateLegacyCreature).not.toHaveBeenCalled()
  })

  it.each(['', 'owner', '0', '9001.0'])('fails closed when GITHUB_OWNER_ID is missing or invalid: %s', async (configuredId) => {
    vi.stubEnv('GITHUB_OWNER_ID', configuredId)
    mocks.session = { handle: 'owner', githubId: 9001, avatarUrl: null }

    const { loadAccountProductState } = await import('./account-product-state')
    const result = await loadAccountProductState(legacyState)

    expect(result.status).toBe('available')
    expect(mocks.readGithubCache).not.toHaveBeenCalled()
    expect(mocks.migrateLegacyCreature).not.toHaveBeenCalled()
  })
})
