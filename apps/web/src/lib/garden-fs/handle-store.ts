/**
 * IndexedDB persistence for the connected directory handle, so a returning
 * user is not re-prompted with the folder picker on every visit.
 *
 * `FileSystemDirectoryHandle` is structured-cloneable in Chromium, so it can
 * be stored inside a small IndexedDB record with its opaque source ID; no
 * serialization needed. This file never touches file contents, only the
 * handle object itself -- see `fsa-source.ts` for the actual reads.
 *
 * Every function here is best-effort and never throws: a user with
 * IndexedDB disabled (private browsing in some browsers) should fall back to
 * "prompt every time", not a crash.
 *
 * NEVER THROWING IS NOT ENOUGH. It also has to always SETTLE. This file
 * caused a bug where /write hung on "Checking for a previously connected
 * garden..." after navigating away and back, fixable only by a full refresh.
 * A promise that never settles is invisible to `try/catch`, so the
 * best-effort contract above silently did not hold. The three fixes below
 * are each about that: a rejection is recoverable, a hang is not.
 */

import { createGardenSourceId } from './types'

const DB_NAME = 'terrarium-garden-fs'
const DB_VERSION = 1
const STORE_NAME = 'handles'
const HANDLE_KEY = 'directory'

/** The value stored for a connected garden. */
export interface StoredGardenHandle {
  readonly handle: FileSystemDirectoryHandle
  readonly sourceId: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => {
      // Never be the connection that blocks someone else's open. Without
      // this, a stale connection in another tab (or a leaked one in this
      // document) deadlocks every later open.
      req.result.onversionchange = () => req.result.close()
      resolve(req.result)
    }
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'))
    // The spec fires `blocked` INSTEAD of success or error, so without this
    // handler a blocked open settles neither and the caller waits forever.
    // This was the hang.
    req.onblocked = () => reject(new Error('IndexedDB open blocked'))
  })
}

/**
 * Runs one transaction against the store and always closes the connection.
 *
 * `db.close()` lives in a `finally` rather than after the await, because the
 * previous version skipped it on every rejection and leaked a live connection
 * for the life of the document. A leaked connection is exactly what makes a
 * later open block, which is why the hang only cleared on a full refresh:
 * tearing down the document was the only thing releasing it.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void
): Promise<T> {
  let db: IDBDatabase | null = null
  try {
    db = await openDb()
    const database = db
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, mode)
      // An abort settles neither the request nor `oncomplete`, so this is the
      // third way the old code could hang.
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
      run(tx.objectStore(STORE_NAME), resolve, reject)
    })
  } finally {
    db?.close()
  }
}

/** Persists the handle and its source identity. Best-effort: a failure here
 * just means the next visit re-prompts, never a thrown error surfacing to the
 * caller. The optional ID keeps direct callers of the old one-argument API
 * working while ensuring every newly stored value has an identity. */
export async function saveHandle(
  handle: FileSystemDirectoryHandle,
  sourceId = createGardenSourceId()
): Promise<void> {
  const normalizedSourceId = sourceId.trim()
  const stableSourceId =
    normalizedSourceId && normalizedSourceId !== handle.name
      ? normalizedSourceId
      : createGardenSourceId()
  try {
    await withStore<void>('readwrite', (store, resolve, reject) => {
      const req = store.put({ handle, sourceId: stableSourceId }, HANDLE_KEY)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // Best-effort, per file header.
  }
}

function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  )
}

function isStoredGardenHandle(value: unknown): value is StoredGardenHandle {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { handle?: unknown; sourceId?: unknown }
  return (
    isDirectoryHandle(candidate.handle) &&
    typeof candidate.sourceId === 'string' &&
    candidate.sourceId.trim().length > 0 &&
    candidate.sourceId.trim() !== candidate.handle.name
  )
}

/**
 * Reads back the persisted handle and source identity. Older releases stored
 * the raw directory handle at this key, so that shape is accepted and
 * upgraded in place with a newly generated opaque ID.
 */
export async function loadStoredHandle(): Promise<StoredGardenHandle | null> {
  try {
    const value = await withStore<unknown | null>(
      'readonly',
      (store, resolve, reject) => {
        const req = store.get(HANDLE_KEY)
        req.onsuccess = () => resolve(req.result ?? null)
        req.onerror = () => reject(req.error)
      }
    )

    if (isStoredGardenHandle(value)) return value

    // A partially written/new-format record can still be repaired as long as
    // its handle survived. This also keeps an invalid/blank ID from turning a
    // previously connected garden into a permanently unavailable one.
    if (typeof value === 'object' && value !== null && 'handle' in value) {
      const candidate = value as { handle?: unknown; sourceId?: unknown }
      if (isDirectoryHandle(candidate.handle)) {
        const candidateSourceId =
          typeof candidate.sourceId === 'string' ? candidate.sourceId.trim() : ''
        const migrated = {
          handle: candidate.handle,
          sourceId:
            candidateSourceId && candidateSourceId !== candidate.handle.name
              ? candidateSourceId
              : createGardenSourceId(),
        }
        await saveHandle(migrated.handle, migrated.sourceId)
        return migrated
      }
    }

    // Backwards compatibility for the old raw-handle value. Persist the
    // migrated record so subsequent restores keep the same source identity.
    if (isDirectoryHandle(value)) {
      const migrated = { handle: value, sourceId: createGardenSourceId() }
      await saveHandle(migrated.handle, migrated.sourceId)
      return migrated
    }

    return null
  } catch {
    return null
  }
}

/** Reads back the persisted handle, or null when none was ever saved (or
 * storage is unavailable). Kept as the original handle-only API for callers
 * that do not need source identity. */
export async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  const stored = await loadStoredHandle()
  return stored?.handle ?? null
}

/** Forgets the stored handle. Does not touch any file on disk. Never throws. */
export async function clearHandle(): Promise<void> {
  try {
    await withStore<void>('readwrite', (store, resolve, reject) => {
      const req = store.delete(HANDLE_KEY)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // Best-effort, per file header.
  }
}
