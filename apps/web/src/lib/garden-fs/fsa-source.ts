/**
 * File System Access API implementation of the `GardenSource` /
 * `GardenConnection` contract (see `types.ts`, frozen). Nothing in this file
 * ever sends file contents anywhere but back to the caller in-process: every
 * read is `handle.getFile().text()`, kept entirely in memory, never fetched
 * to or from a server.
 */
import type { GardenConnection, GardenFile, GardenSource } from './types'
import { createGardenSourceId, isMarkdownFile } from './types'
import { clearHandle, loadStoredHandle, saveHandle } from './handle-store'

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

/** Directories that are not part of a Markdown garden. `.obsidian` is the
 * vault's own application state; the others are common VCS, dependency, and
 * operating-system folders that should not become notes when a user mounts a
 * broad project directory. Hidden directories are covered separately below.
 */
const IGNORED_DIRECTORY_NAMES = new Set([
  '.obsidian',
  '.git',
  'node_modules',
  'System Volume Information',
  '$RECYCLE.BIN',
].map((name) => name.toLowerCase()))

function isIgnoredDirectory(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(name.toLowerCase())
}

/**
 * File System Access paths are one name at a time, while GardenSource names
 * are relative paths so nested Markdown files remain addressable. Normalize
 * the separator at this boundary and reject traversal/absolute paths before
 * touching a browser handle.
 */
function pathSegments(name: string): string[] {
  const normalized = name.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid garden path: ${name}`)
  }
  return segments
}

function hasIgnoredDirectorySegment(segments: string[]): boolean {
  return segments.slice(0, -1).some(isIgnoredDirectory)
}

/** `GardenSource` over a single `FileSystemDirectoryHandle`. It recursively
 * scans nested directories and exposes each Markdown file by its relative
 * POSIX path, e.g. `projects/ideas.md`. Treats `.md` and `.mdx` alike, per
 * the frozen contract. */
export class FsaGardenSource implements GardenSource {
  readonly sourceId: string

  constructor(
    private readonly handle: FileSystemDirectoryHandle,
    sourceId = createGardenSourceId()
  ) {
    const normalizedSourceId = sourceId.trim()
    this.sourceId =
      normalizedSourceId && normalizedSourceId !== handle.name
        ? normalizedSourceId
        : createGardenSourceId()
  }

  get name(): string {
    return this.handle.name
  }

  async list(): Promise<GardenFile[]> {
    const files: GardenFile[] = []
    await this.scanDirectory(this.handle, '', files)
    return files
  }

  private async scanDirectory(
    directory: FileSystemDirectoryHandle,
    prefix: string,
    files: GardenFile[],
  ): Promise<void> {
    try {
      for await (const [entryName, entry] of directory.entries()) {
        if (entry.kind === 'directory') {
          if (isIgnoredDirectory(entryName)) continue
          const nestedPrefix = prefix ? `${prefix}/${entryName}` : entryName
          // A revoked/unreadable nested directory makes the whole scan
          // incomplete. Let list() reject instead of publishing a partial
          // activity baseline.
          await this.scanDirectory(
            entry as FileSystemDirectoryHandle,
            nestedPrefix,
            files
          )
          continue
        }

        if (!isMarkdownFile(entryName)) continue
        try {
          const fileHandle = entry as FileSystemFileHandle
          const file = await fileHandle.getFile()
          const content = await file.text()
          files.push({
            name: prefix ? `${prefix}/${entryName}` : entryName,
            content,
            lastModified: file.lastModified,
          })
        } catch (error) {
          // A partial scan is unsafe for the activity ledger: publishing it
          // would make the next successful scan look like a set of new notes.
          // Fail closed so the caller keeps the previous baseline and retries.
          throw error
        }
      }
    } catch (error) {
      // A partial scan is unsafe for the activity ledger: publishing it would
      // make the next successful scan look like a set of new notes. Siblings
      // are intentionally not returned as a misleading "complete" listing.
      throw error
    }
  }

  async read(name: string): Promise<string | null> {
    try {
      const segments = pathSegments(name)
      if (hasIgnoredDirectorySegment(segments)) return null
      const fileHandle = await this.fileHandleAt(segments)
      const file = await fileHandle.getFile()
      return await file.text()
    } catch {
      return null
    }
  }

  async write(name: string, content: string): Promise<void> {
    const segments = pathSegments(name)
    if (hasIgnoredDirectorySegment(segments)) {
      throw new Error(`Cannot write inside an ignored directory: ${name}`)
    }
    const fileHandle = await this.fileHandleAt(segments, true)
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
      const segments = pathSegments(name)
      if (hasIgnoredDirectorySegment(segments)) return
      const directory = await this.directoryAt(segments.slice(0, -1))
      await directory.removeEntry(segments[segments.length - 1])
    } catch (error) {
      // No-op when already absent, per the GardenSource contract. Permission
      // and I/O failures must still reject so the editor does not publish a
      // scan for a delete that never completed.
      if (
        typeof DOMException !== 'undefined' &&
        error instanceof DOMException &&
        error.name === 'NotFoundError'
      ) {
        return
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: unknown }).name === 'NotFoundError'
      ) {
        return
      }
      if (error instanceof Error && error.message === 'NotFoundError') return
      throw error
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const fromSegments = pathSegments(from)
    const toSegments = pathSegments(to)
    if (hasIgnoredDirectorySegment(fromSegments) || hasIgnoredDirectorySegment(toSegments)) {
      return
    }
    if (fromSegments.join('/') === toSegments.join('/')) return
    const content = await this.read(from)
    if (content === null) return
    const destinationBefore = await this.read(to)
    await this.write(to, content)
    try {
      await this.remove(from)
    } catch (error) {
      // `write(to)` is the only portable move primitive in FSA. If deleting the
      // source fails, restore the destination's prior bytes (or remove the new
      // destination) so callers never observe a half-completed rename.
      try {
        if (destinationBefore === null) await this.remove(to)
        else await this.write(to, destinationBefore)
      } catch {
        // Preserve the original source-removal error; the caller can surface a
        // retryable I/O failure and the next scan will reconcile the paths.
      }
      throw error
    }
  }

  private async directoryAt(
    segments: string[],
    create = false
  ): Promise<FileSystemDirectoryHandle> {
    let directory = this.handle
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create })
    }
    return directory
  }

  private async fileHandleAt(
    segments: string[],
    create = false
  ): Promise<FileSystemFileHandle> {
    const directory = await this.directoryAt(segments.slice(0, -1), create)
    return directory.getFileHandle(segments[segments.length - 1], { create })
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
      const sourceId = createGardenSourceId()
      await saveHandle(handle, sourceId)
      return new FsaGardenSource(handle, sourceId)
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
    const stored = await loadStoredHandle()
    if (!stored) return null
    const granted = await hasPermission(stored.handle, 'readwrite')
    if (!granted) return null
    return new FsaGardenSource(stored.handle, stored.sourceId)
  }

  async disconnect(): Promise<void> {
    await clearHandle()
  }
}
