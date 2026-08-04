/**
 * File System Access API implementation of the `GardenSource` /
 * `GardenConnection` contract (see `types.ts`, frozen). Nothing in this file
 * ever sends file contents anywhere but back to the caller in-process: every
 * read is `handle.getFile().text()`, kept entirely in memory, never fetched
 * to or from a server.
 */
import type { GardenConnection, GardenFile, GardenSource } from './types'
import { isMarkdownFile } from './types'
import { clearHandle, loadHandle, saveHandle } from './handle-store'

/** True only on browsers that expose the File System Access API. Today that
 * means Chromium; Firefox and Safari do not implement it. */
export function isFsaSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/**
 * Resolves to `fallback` if `promise` has not settled within `ms`.
 *
 * Exists because `try/catch` cannot rescue a promise that never settles, and
 * every await on a browser-provided handle is a promise this code does not
 * control. A rejection is recoverable; a hang is a dead end.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** How long any single handle permission check may take before we treat the
 *  folder as unavailable. Generous: this is a local call that normally
 *  returns in single-digit milliseconds. */
const PERMISSION_TIMEOUT_MS = 5000

async function hasPermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite'
): Promise<boolean> {
  try {
    // THE TIMEOUT IS THE POINT, not the try/catch. `queryPermission` is a
    // browser call on a handle persisted across sessions, and it can stall
    // rather than reject when the folder it refers to has moved or its drive
    // is no longer mounted. A stall here used to strand /write on "Checking
    // for a previously connected garden..." with no way out but a refresh,
    // because a pending promise is invisible to the catch below.
    const state = await withTimeout(
      handle.queryPermission({ mode }),
      PERMISSION_TIMEOUT_MS,
      'denied' as PermissionState
    )
    return state === 'granted'
  } catch {
    return false
  }
}

/** `GardenSource` over a single `FileSystemDirectoryHandle`. Flat: reads only
 * the top-level entries of the folder, matching the "unique within a folder"
 * contract on `GardenFile.name`. Treats `.md` and `.mdx` alike, per the
 * frozen contract. */
export class FsaGardenSource implements GardenSource {
  constructor(private readonly handle: FileSystemDirectoryHandle) {}

  get name(): string {
    return this.handle.name
  }

  async list(): Promise<GardenFile[]> {
    const files: GardenFile[] = []
    for await (const [entryName, entry] of this.handle.entries()) {
      if (entry.kind !== 'file') continue
      if (!isMarkdownFile(entryName)) continue
      try {
        const fileHandle = entry as FileSystemFileHandle
        const file = await fileHandle.getFile()
        const content = await file.text()
        files.push({ name: entryName, content, lastModified: file.lastModified })
      } catch {
        // A single unreadable file (permission race, deleted mid-scan) must
        // not take the whole listing down.
      }
    }
    return files
  }

  async read(name: string): Promise<string | null> {
    try {
      const fileHandle = await this.handle.getFileHandle(name)
      const file = await fileHandle.getFile()
      return await file.text()
    } catch {
      return null
    }
  }

  async write(name: string, content: string): Promise<void> {
    const fileHandle = await this.handle.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(content)
    } catch (err) {
      // Chromium holds an exclusive lock on the file until the stream is
      // closed or aborted, and writes go to a swap file that only becomes the
      // real file on close. Letting a failed write escape without aborting
      // stranded that swap file and left the note locked against every later
      // save, so the user could not retry.
      await writable.abort().catch(() => {})
      throw err
    }
    await writable.close()
  }

  async remove(name: string): Promise<void> {
    try {
      await this.handle.removeEntry(name)
    } catch {
      // No-op when already absent, per the GardenSource contract.
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const content = await this.read(from)
    if (content === null) return
    await this.write(to, content)
    await this.remove(from)
  }
}

/** `GardenConnection` over the File System Access API, with the handle
 * persisted to IndexedDB (`handle-store.ts`) so a returning user is not
 * re-prompted. */
export class FsaGardenConnection implements GardenConnection {
  isSupported(): boolean {
    return isFsaSupported()
  }

  async connect(): Promise<GardenSource | null> {
    if (!this.isSupported()) return null
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      await saveHandle(handle)
      return new FsaGardenSource(handle)
    } catch {
      // AbortError on user cancel, or any other failure. Either way the
      // caller sees "no connection", never a thrown exception.
      return null
    }
  }

  /**
   * Reconnects a previously granted folder without prompting. Returns null
   * when there is no stored handle, or when the browser has since revoked
   * permission -- that is a normal outcome, not an error, and this
   * deliberately does NOT call `requestPermission()` here: that can pop a
   * permission prompt on page load with no user gesture behind it, which is
   * the surprise-prompt UX the frozen contract explicitly rules out. Only
   * `connect()` (a direct response to a user click) prompts.
   */
  async restore(): Promise<GardenSource | null> {
    if (!this.isSupported()) return null
    const handle = await loadHandle()
    if (!handle) return null
    const granted = await hasPermission(handle, 'readwrite')
    if (!granted) return null
    return new FsaGardenSource(handle)
  }

  async disconnect(): Promise<void> {
    await clearHandle()
  }
}
