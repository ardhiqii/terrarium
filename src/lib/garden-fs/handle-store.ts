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
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'))
  })
}

/** Persists the handle. Best-effort: a failure here just means the next
 * visit re-prompts, never a thrown error surfacing to the caller. */
export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    // Best-effort, per file header.
  }
}

/** Reads back the persisted handle, or null when none was ever saved (or
 * storage is unavailable). Never throws. */
export async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb()
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY)
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return handle
  } catch {
    return null
  }
}

/** Forgets the stored handle. Does not touch any file on disk. Never throws. */
export async function clearHandle(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(HANDLE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    // Best-effort, per file header.
  }
}
