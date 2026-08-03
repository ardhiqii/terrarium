import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FsaGardenSource, FsaGardenConnection, isFsaSupported } from './fsa-source'

/**
 * The test environment (vitest.config.mts: `environment: 'node'`) has no
 * `window`, so `isFsaSupported()` is exercised at its real "unsupported"
 * value here -- exactly what a non-Chromium browser sees -- rather than
 * mocked. `FsaGardenSource` itself is tested against a small fake
 * `FileSystemDirectoryHandle`, since the real API only exists in a browser.
 */

interface FakeFile {
  content: string
  lastModified: number
}

/** Minimal fake of the File System Access API surface this module uses. */
function makeFakeDirectory(initial: Record<string, string> = {}) {
  const files = new Map<string, FakeFile>()
  for (const [name, content] of Object.entries(initial)) {
    files.set(name, { content, lastModified: 1000 })
  }

  const fileHandleFor = (name: string) => ({
    kind: 'file' as const,
    name,
    async getFile() {
      const f = files.get(name)
      if (!f) throw new Error('NotFoundError')
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
          files.set(name, { content: buffer, lastModified: Date.now() })
        },
      }
    },
  })

  const handle = {
    kind: 'directory' as const,
    name: 'fake-garden',
    async *entries(): AsyncIterableIterator<[string, unknown]> {
      for (const name of files.keys()) {
        yield [name, fileHandleFor(name)]
      }
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (options?.create) {
          files.set(name, { content: '', lastModified: Date.now() })
        } else {
          throw new Error('NotFoundError')
        }
      }
      return fileHandleFor(name)
    },
    async removeEntry(name: string) {
      if (!files.has(name)) throw new Error('NotFoundError')
      files.delete(name)
    },
    _files: files,
  }

  return handle as unknown as FileSystemDirectoryHandle & { _files: Map<string, FakeFile> }
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
