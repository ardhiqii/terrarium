/**
 * IndexedDB persistence for the connected directory handle, so a returning
 * user is not re-prompted with the folder picker on every visit.
 *
 * `FileSystemDirectoryHandle` is structured-cloneable in Chromium, so it can
 * be stored directly as an IndexedDB value; no serialization needed. This
 * file never touches file contents, only the handle object itself -- see
 * `fsa-source.ts` for the actual reads.
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

const DB_NAME = 'terrarium-garden-fs'
const DB_VERSION = 1
const STORE_NAME = 'handles'
const HANDLE_KEY = 'directory'

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

/** Persists the handle. Best-effort: a failure here just means the next
 * visit re-prompts, never a thrown error surfacing to the caller. */
export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await withStore<void>('readwrite', (store, resolve, reject) => {
      const req = store.put(handle, HANDLE_KEY)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // Best-effort, per file header.
  }
}

/** Reads back the persisted handle, or null when none was ever saved (or
 * storage is unavailable). Never throws, and always settles. */
export async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await withStore<FileSystemDirectoryHandle | null>(
      'readonly',
      (store, resolve, reject) => {
        const req = store.get(HANDLE_KEY)
        req.onsuccess = () =>
          resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
        req.onerror = () => reject(req.error)
      }
    )
  } catch {
    return null
  }
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
