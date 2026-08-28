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

/**
 * Regression tests for the /write hang.
 *
 * Navigating away from /write and back left the page stuck on "Checking for
 * a previously connected garden..." forever, clearable only by a full page
 * refresh. The cause was that these functions could fail to SETTLE, which
 * `try/catch` cannot see: `openDb` had no `onblocked` handler (the spec fires
 * `blocked` INSTEAD of success or error), transactions had no `onabort`, and
 * `db.close()` sat after the awaited transaction so it was skipped on every
 * rejection, leaking a connection that then blocked the next open. Only
 * tearing down the document released it, which is why refresh was the one
 * thing that worked.
 *
 * These rely on vitest's test timeout: a promise that never settles fails
 * the test rather than passing quietly, which is the property being guarded.
 */

import { beforeEach, afterEach, vi } from 'vitest'

type Handler = (() => void) | null

function fakeRequest() {
  return { onsuccess: null as Handler, onerror: null as Handler, result: undefined as unknown, error: null }
}

/** Minimal IndexedDB stand-in whose failure mode is chosen per test. */
function stubIndexedDb(mode: 'blocked' | 'abort' | 'request-error') {
  const closed = { count: 0 }

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    close: () => {
      closed.count++
    },
    onversionchange: null as Handler,
    transaction: () => {
      const tx: Record<string, unknown> = { onabort: null, onerror: null, error: new Error('tx failed') }
      const store = {
        get: () => {
          const req = fakeRequest()
          queueMicrotask(() => {
            if (mode === 'abort') (tx.onabort as Handler)?.()
            else if (mode === 'request-error') req.onerror?.()
          })
          return req
        },
        put: () => fakeRequest(),
        delete: () => fakeRequest(),
      }
      ;(tx as { objectStore: () => typeof store }).objectStore = () => store
      return tx
    },
  }

  vi.stubGlobal('indexedDB', {
    open: () => {
      const req: Record<string, unknown> = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
        result: db,
        error: null,
      }
      queueMicrotask(() => {
        if (mode === 'blocked') (req.onblocked as Handler)?.()
        else (req.onsuccess as Handler)?.()
      })
      return req
    },
  })

  return closed
}

describe('handle-store: never hangs', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** The hang itself. A blocked open fires neither success nor error. */
  it('settles when the database open is blocked', async () => {
    stubIndexedDb('blocked')
    await expect(loadHandle()).resolves.toBeNull()
  })

  it('settles when the transaction aborts', async () => {
    stubIndexedDb('abort')
    await expect(loadHandle()).resolves.toBeNull()
  })

  /**
   * The leak that caused the block. A rejected transaction used to skip
   * db.close(), holding a connection open for the life of the document.
   */
  it('closes the connection even when the read fails', async () => {
    const closed = stubIndexedDb('request-error')
    await expect(loadHandle()).resolves.toBeNull()
    expect(closed.count).toBe(1)
  })

  it('closes the connection when the transaction aborts', async () => {
    const closed = stubIndexedDb('abort')
    await loadHandle()
    expect(closed.count).toBe(1)
  })
})
