import { describe, it, expect } from 'vitest'
import { saveHandle, loadHandle, clearHandle } from './handle-store'

/**
 * The test environment has no `indexedDB` global (vitest.config.mts:
 * `environment: 'node'`), which is exactly the "storage unavailable" case
 * every function here must degrade from without throwing -- e.g. a user
 * with IndexedDB disabled in private browsing. This suite proves that
 * degradation rather than mocking IndexedDB itself, since a real browser's
 * happy path (save now, load the same handle back later) is better proven
 * by the manual browser verification in the T23 report than by a fake
 * IndexedDB implementation here.
 */

describe('handle-store: no IndexedDB available', () => {
  it('loadHandle resolves to null rather than throwing', async () => {
    await expect(loadHandle()).resolves.toBeNull()
  })

  it('saveHandle resolves rather than throwing', async () => {
    const fakeHandle = { name: 'whatever' } as unknown as FileSystemDirectoryHandle
    await expect(saveHandle(fakeHandle)).resolves.toBeUndefined()
  })

  it('clearHandle resolves rather than throwing even with nothing stored', async () => {
    await expect(clearHandle()).resolves.toBeUndefined()
  })
})
