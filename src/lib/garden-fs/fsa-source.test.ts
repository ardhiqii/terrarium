import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FsaGardenSource, FsaGardenConnection, isFsaSupported, withTimeout } from './fsa-source'

/**
 * The test environment (vitest.config.mts: `environment: 'node'`) has no
 * `window`, so `isFsaSupported()` is exercised at its real "unsupported"
 * value here -- exactly what a non-Chromium browser sees -- rather than
 * mocked. `FsaGardenSource` itself is tested against a small fake
 * `FileSystemDirectoryHandle`, since the real API only exists in a browser.
 */

interface FakeFile {
  kind: 'file'
  content: string
  lastModified: number
}

interface FakeDirectory {
  kind: 'directory'
  name: string
  path: string
  children: Map<string, FakeNode>
}

type FakeNode = FakeFile | FakeDirectory

/** Minimal fake of the File System Access API surface this module uses. */
function makeFakeDirectory(initial: Record<string, string> = {}, unreadableDirectories: string[] = []) {
  const root: FakeDirectory = {
    kind: 'directory',
    name: 'fake-garden',
    path: '',
    children: new Map(),
  }
  const unreadable = new Set(unreadableDirectories)

  const directoryAt = (path: string, create = false): FakeDirectory => {
    let directory = root
    for (const segment of path.split('/').filter(Boolean)) {
      const existing = directory.children.get(segment)
      if (existing?.kind === 'directory') {
        directory = existing
      } else if (create) {
        const created: FakeDirectory = {
          kind: 'directory',
          name: segment,
          path: directory.path ? `${directory.path}/${segment}` : segment,
          children: new Map(),
        }
        directory.children.set(segment, created)
        directory = created
      } else {
        throw new Error('NotFoundError')
      }
    }
    return directory
  }

  for (const [name, content] of Object.entries(initial)) {
    const segments = name.split('/')
    const fileName = segments.pop()!
    directoryAt(segments.join('/'), true).children.set(fileName, {
      kind: 'file',
      content,
      lastModified: 1000,
    })
  }

  const fileHandleFor = (directory: FakeDirectory, name: string) => ({
    kind: 'file' as const,
    name,
    async getFile() {
      const f = directory.children.get(name)
      if (!f || f.kind !== 'file') throw new Error('NotFoundError')
      return {
        lastModified: f.lastModified,
        async text() {
          return f.content
        },
      }
    },
    async createWritable() {
      let buffer = ''
      return {
        async write(data: string) {
          buffer = data
        },
        async close() {
          directory.children.set(name, { kind: 'file', content: buffer, lastModified: Date.now() })
        },
        async abort() {
          // Matches the method used by the production implementation on a
          // failed write; this fake does not simulate write failures.
        },
      }
    },
  })

  const directoryHandleFor = (directory: FakeDirectory) => ({
    kind: 'directory' as const,
    name: directory.name,
    async *entries(): AsyncIterableIterator<[string, unknown]> {
      if (unreadable.has(directory.path)) throw new Error('NotAllowedError')
      for (const [name, node] of directory.children) {
        yield [
          name,
          node.kind === 'file' ? fileHandleFor(directory, name) : directoryHandleFor(node),
        ]
      }
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      const existing = directory.children.get(name)
      if (!existing) {
        if (options?.create) {
          directory.children.set(name, { kind: 'file', content: '', lastModified: Date.now() })
        } else {
          throw new Error('NotFoundError')
        }
      }
      const node = directory.children.get(name)
      if (!node || node.kind !== 'file') throw new Error('TypeMismatchError')
      return fileHandleFor(directory, name)
    },
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      const existing = directory.children.get(name)
      if (!existing) {
        if (!options?.create) throw new Error('NotFoundError')
        return directoryHandleFor(directoryAt(directory.path ? `${directory.path}/${name}` : name, true))
      }
      if (existing.kind !== 'directory') throw new Error('TypeMismatchError')
      return directoryHandleFor(existing)
    },
    async removeEntry(name: string) {
      if (!directory.children.has(name)) throw new Error('NotFoundError')
      directory.children.delete(name)
    },
  })

  return directoryHandleFor(root) as unknown as FileSystemDirectoryHandle
}

describe('isFsaSupported', () => {
  it('is false in an environment with no window.showDirectoryPicker (e.g. non-Chromium, or this test env)', () => {
    expect(isFsaSupported()).toBe(false)
  })
})

describe('FsaGardenSource: list', () => {
  it('lists only markdown files, ignoring anything else', async () => {
    const handle = makeFakeDirectory({
      'a.md': '---\ntitle: A\n---\nbody',
      'b.mdx': 'body',
      'image.png': 'not markdown',
      'notes.txt': 'not markdown',
    })
    const source = new FsaGardenSource(handle)
    const files = await source.list()
    const names = files.map((f) => f.name).sort()
    expect(names).toEqual(['a.md', 'b.mdx'])
  })

  it('returns an empty list, not an error, for a folder with no markdown at all', async () => {
    const handle = makeFakeDirectory({ 'readme.txt': 'hi' })
    const source = new FsaGardenSource(handle)
    await expect(source.list()).resolves.toEqual([])
  })

  it('recursively lists nested markdown files by relative path', async () => {
    const handle = makeFakeDirectory({
      'projects/alpha/readme.md': 'alpha',
      'projects/alpha/notes/idea.mdx': 'idea',
      'projects/alpha/notes/image.png': 'not markdown',
      'top.md': 'top',
    })
    const source = new FsaGardenSource(handle)
    const files = await source.list()

    expect(files.map((file) => file.name).sort()).toEqual([
      'projects/alpha/notes/idea.mdx',
      'projects/alpha/readme.md',
      'top.md',
    ])
  })

  it('ignores Obsidian, hidden, VCS, dependency, and system directories', async () => {
    const handle = makeFakeDirectory({
      '.obsidian/app.md': 'ignored',
      '.private/secret.md': 'ignored',
      '.git/history.md': 'ignored',
      'node_modules/package.md': 'ignored',
      'System Volume Information/index.md': 'ignored',
      '$RECYCLE.BIN/deleted.md': 'ignored',
      'visible/kept.md': 'kept',
    })
    const source = new FsaGardenSource(handle)

    await expect(source.list()).resolves.toEqual([
      expect.objectContaining({ name: 'visible/kept.md', content: 'kept' }),
    ])
  })

  it('continues scanning sibling directories when a nested directory is unreadable', async () => {
    const handle = makeFakeDirectory(
      {
        'blocked/secret.md': 'unreadable',
        'available/note.md': 'readable',
      },
      ['blocked']
    )
    const source = new FsaGardenSource(handle)

    await expect(source.list()).resolves.toEqual([
      expect.objectContaining({ name: 'available/note.md', content: 'readable' }),
    ])
  })

  it('exposes the folder name', () => {
    const handle = makeFakeDirectory({})
    const source = new FsaGardenSource(handle)
    expect(source.name).toBe('fake-garden')
  })
})

describe('FsaGardenSource: read/write/remove/rename', () => {
  it('reads a file that exists', async () => {
    const handle = makeFakeDirectory({ 'a.md': 'hello' })
    const source = new FsaGardenSource(handle)
    await expect(source.read('a.md')).resolves.toBe('hello')
  })

  it('returns null for a file that does not exist, rather than throwing', async () => {
    const handle = makeFakeDirectory({})
    const source = new FsaGardenSource(handle)
    await expect(source.read('missing.md')).resolves.toBeNull()
  })

  it('creates a new file on write', async () => {
    const handle = makeFakeDirectory({})
    const source = new FsaGardenSource(handle)
    await source.write('new.md', 'new content')
    await expect(source.read('new.md')).resolves.toBe('new content')
  })

  it('is a no-op, not an error, when removing an already-absent file', async () => {
    const handle = makeFakeDirectory({})
    const source = new FsaGardenSource(handle)
    await expect(source.remove('missing.md')).resolves.toBeUndefined()
  })

  it('rename moves bytes without altering content', async () => {
    const handle = makeFakeDirectory({ 'old.md': 'content here' })
    const source = new FsaGardenSource(handle)
    await source.rename('old.md', 'new.md')
    await expect(source.read('old.md')).resolves.toBeNull()
    await expect(source.read('new.md')).resolves.toBe('content here')
  })

  it('creates, edits, renames, and removes files in nested directories', async () => {
    const handle = makeFakeDirectory({})
    const source = new FsaGardenSource(handle)

    await source.write('projects/alpha/note.md', 'first')
    await expect(source.read('projects/alpha/note.md')).resolves.toBe('first')

    await source.write('projects/alpha/note.md', 'edited')
    await source.rename('projects/alpha/note.md', 'archive/final.mdx')
    await expect(source.read('projects/alpha/note.md')).resolves.toBeNull()
    await expect(source.read('archive/final.mdx')).resolves.toBe('edited')

    await source.remove('archive/final.mdx')
    await expect(source.read('archive/final.mdx')).resolves.toBeNull()
  })
})

describe('FsaGardenConnection: degrades on an unsupported browser', () => {
  let connection: FsaGardenConnection

  beforeEach(() => {
    connection = new FsaGardenConnection()
  })

  it('isSupported reflects the real API surface (false here)', () => {
    expect(connection.isSupported()).toBe(false)
  })

  it('connect() returns null rather than throwing when unsupported', async () => {
    await expect(connection.connect()).resolves.toBeNull()
  })

  it('restore() returns null rather than throwing when unsupported', async () => {
    await expect(connection.restore()).resolves.toBeNull()
  })

  it('disconnect() never throws even with nothing stored', async () => {
    await expect(connection.disconnect()).resolves.toBeUndefined()
  })
})

describe('FsaGardenConnection: connect() failure paths', () => {
  it('connect() resolves null (not a thrown error) when showDirectoryPicker rejects, e.g. user cancel', async () => {
    const win = { showDirectoryPicker: vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')) }
    vi.stubGlobal('window', win)
    const connection = new FsaGardenConnection()
    await expect(connection.connect()).resolves.toBeNull()
    vi.unstubAllGlobals()
  })
})

/**
 * The /write hang, second half.
 *
 * `restore()` awaits two browser-owned promises: IndexedDB (fixed separately
 * in handle-store) and `handle.queryPermission()`. The permission call is
 * wrapped in try/catch, which looks safe and is not: a catch cannot rescue a
 * promise that never settles, and Chromium can stall that call rather than
 * reject it when a persisted handle points at a folder that has moved or a
 * drive that is no longer mounted. A stall stranded /write on "Checking for a
 * previously connected garden..." with no exit but a refresh.
 *
 * These use vitest's timeout as the assertion: a hang fails the test.
 */
describe('withTimeout', () => {
  it('passes through a value that settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'fallback')).resolves.toBe('ok')
  })

  it('falls back rather than hanging when the promise never settles', async () => {
    const never = new Promise<string>(() => {})
    await expect(withTimeout(never, 20, 'fallback')).resolves.toBe('fallback')
  })

  it('still rejects for a genuine failure, which is recoverable', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'fallback')).rejects.toThrow(
      'boom'
    )
  })

  it('does not leave a pending timer that keeps the process alive', async () => {
    const spy = vi.spyOn(globalThis, 'clearTimeout')
    await withTimeout(Promise.resolve(1), 50_000, 0)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
