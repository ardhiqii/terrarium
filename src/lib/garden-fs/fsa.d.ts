/**
 * Ambient augmentation for the File System Access API surface this task
 * needs. TypeScript's bundled `lib.dom.d.ts` (as of the version pinned in
 * this repo) already declares `FileSystemDirectoryHandle`,
 * `FileSystemFileHandle`, and `FileSystemHandle`, but is missing:
 *
 * - `FileSystemDirectoryHandle.entries()/values()/keys()` (the async
 *   iterable surface used to list a directory's contents)
 * - `FileSystemHandle.queryPermission()/requestPermission()` (the
 *   permission-lifecycle methods `restore()`/`connect()` depend on)
 * - `Window.showDirectoryPicker()` (the entry point into the whole API)
 *
 * These are real, shipped Chromium APIs; only the ambient types lag. Scoped
 * to this directory since it is the one place in the project that talks to
 * this API directly.
 */

export {}

type FsaPermissionMode = 'read' | 'readwrite'

interface FileSystemPermissionDescriptor {
  mode?: FsaPermissionMode
}

interface DirectoryPickerOptions {
  id?: string
  mode?: FsaPermissionMode
  startIn?:
    | 'desktop'
    | 'documents'
    | 'downloads'
    | 'music'
    | 'pictures'
    | 'videos'
    | FileSystemDirectoryHandle
}

declare global {
  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>
    requestPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>
  }

  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>
    values(): AsyncIterableIterator<FileSystemHandle>
    keys(): AsyncIterableIterator<string>
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>
  }
}
