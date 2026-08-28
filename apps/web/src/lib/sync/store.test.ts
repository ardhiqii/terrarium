/**
 * Tests for the store-selection seam.
 *
 * The point of `store.ts` is that it is the only module naming a concrete
 * `SyncStore`, so the deploy-time swap to a hosted database is a one-file
 * change. Two things are worth holding still: that it hands back a store
 * satisfying the interface contract, and that no other app code has quietly
 * gone back to importing the SQLite implementation directly.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { getSyncStore } from './store'
import { resetSyncStoreForTests } from './sqlite-store'
import type { SyncedUser } from './types'

function fakeUser(handle: string): SyncedUser {
  return {
    handle,
    githubId: 999,
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

describe('getSyncStore', () => {
  beforeEach(() => {
    // Fresh in-memory database per case, so nothing leaks between tests.
    resetSyncStoreForTests(':memory:')
  })

  it('returns a store implementing the full SyncStore surface', () => {
    const store = getSyncStore()
    expect(typeof store.put).toBe('function')
    expect(typeof store.get).toBe('function')
    expect(typeof store.getMany).toBe('function')
    expect(typeof store.remove).toBe('function')
  })

  it('round-trips through whichever implementation is selected', async () => {
    const store = getSyncStore()
    await store.put(fakeUser('octocat'))
    expect(await store.get('octocat')).not.toBeNull()
  })

  it('lowercases handles, the rule every implementation must follow', async () => {
    const store = getSyncStore()
    await store.put(fakeUser('Torvalds'))
    expect(await store.get('torvalds')).not.toBeNull()
  })

  it('skips absent handles in getMany rather than erroring', async () => {
    const store = getSyncStore()
    await store.put(fakeUser('present'))
    const found = await store.getMany(['present', 'never-synced'])
    expect(found).toHaveLength(1)
    expect(found[0]?.handle).toBe('present')
  })

  it('observes the same singleton the SQLite module resets', async () => {
    await getSyncStore().put(fakeUser('before'))
    resetSyncStoreForTests(':memory:')
    expect(await getSyncStore().get('before')).toBeNull()
  })
})

describe('the sqlite-store import is confined to the seam', () => {
  /**
   * Guards the property that makes the adapter swap one file. If a new route
   * or page imports `sqlite-store` directly, swapping in a hosted database
   * would silently leave that caller on the disk-backed store, which on
   * serverless means writes that vanish between requests.
   *
   * `store.ts` is the sanctioned importer. `sqlite-store.test.ts` tests that
   * implementation specifically, and this file reaches for its test-only
   * reset helper, so both are allowed too.
   */
  const allowed = new Set(['store.ts', 'sqlite-store.test.ts', 'store.test.ts'])

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        out.push(...walk(full))
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full)
      }
    }
    return out
  }

  it('is imported only by store.ts and its own test', () => {
    const srcRoot = path.join(process.cwd(), 'apps', 'web', 'src')
    const offenders = walk(srcRoot)
      .filter((file) => !allowed.has(path.basename(file)))
      .filter((file) => /from\s+['"][^'"]*sqlite-store['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcRoot, file))

    expect(offenders).toEqual([])
  })
})
