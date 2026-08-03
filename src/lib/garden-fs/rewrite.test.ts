import { describe, it, expect } from 'vitest'
import { rewriteWikilinks, renameNoteEverywhere } from './rewrite'
import { parseNote, serializeNote, titleToFileName } from './serialize'
import type { GardenFile, GardenSource } from './types'

/**
 * Minimal in-memory `GardenSource`, since T23's real File System Access
 * implementation may not exist yet. Only the methods `rewrite.ts` actually
 * calls are exercised meaningfully; the contract itself is frozen in
 * `types.ts` and not re-tested here.
 */
class FakeGardenSource implements GardenSource {
  readonly name = 'fake-garden'
  private files = new Map<string, string>()

  constructor(initial: Record<string, string> = {}) {
    for (const [name, content] of Object.entries(initial)) {
      this.files.set(name, content)
    }
  }

  async list(): Promise<GardenFile[]> {
    return [...this.files.entries()].map(([name, content]) => ({ name, content }))
  }

  async read(name: string): Promise<string | null> {
    return this.files.get(name) ?? null
  }

  async write(name: string, content: string): Promise<void> {
    this.files.set(name, content)
  }

  async remove(name: string): Promise<void> {
    this.files.delete(name)
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from)
    if (content === undefined) return
    this.files.delete(from)
    this.files.set(to, content)
  }
}

function note(title: string, body: string): string {
  return serializeNote({ title, date: '2026-08-01', tags: [] }, body)
}

describe('rewriteWikilinks', () => {
  // Case 1: exact target match only.
  it('does not touch a longer title that merely starts with the renamed title', () => {
    const files: GardenFile[] = [
      {
        name: 'a.md',
        content:
          'See [[Tools for Thinking]] and also [[Tools for Thinking Extended]].',
      },
    ]

    const [result] = rewriteWikilinks(files, 'Tools for Thinking', 'Thinking Tools')

    expect(result.changed).toBe(true)
    expect(result.content).toBe(
      'See [[Thinking Tools]] and also [[Tools for Thinking Extended]].'
    )
  })

  // Case 2: preserve aliases.
  it('rewrites the target of an aliased link but leaves the display text untouched', () => {
    const files: GardenFile[] = [
      { name: 'a.md', content: 'Related: [[Old Title|a much better name]].' },
    ]

    const [result] = rewriteWikilinks(files, 'Old Title', 'New Title')

    expect(result.content).toBe('Related: [[New Title|a much better name]].')
  })

  it('preserves an alias that happens to repeat the old title text', () => {
    const files: GardenFile[] = [
      { name: 'a.md', content: '[[Old Title|Old Title]]' },
    ]

    const [result] = rewriteWikilinks(files, 'Old Title', 'New Title')

    // Display text is untouched even though it is textually identical to
    // the old target; only the part before the pipe is a link target.
    expect(result.content).toBe('[[New Title|Old Title]]')
  })

  // Case 3: both link forms (title and slug) resolve to the same note.
  it('rewrites both the title form and the slug form of a link', () => {
    const files: GardenFile[] = [
      {
        name: 'a.md',
        content: 'By title: [[Tools for Thinking]]. By slug: [[tools-for-thinking]].',
      },
    ]

    const [result] = rewriteWikilinks(files, 'Tools for Thinking', 'Thinking Tools')

    expect(result.content).toBe(
      'By title: [[Thinking Tools]]. By slug: [[Thinking Tools]].'
    )
  })

  // Case 4: case-insensitive matching, because the resolver lowercases.
  it('matches regardless of case', () => {
    const files: GardenFile[] = [
      { name: 'a.md', content: '[[TOOLS FOR THINKING]] and [[tools for thinking]]' },
    ]

    const [result] = rewriteWikilinks(files, 'Tools for Thinking', 'Thinking Tools')

    expect(result.content).toBe('[[Thinking Tools]] and [[Thinking Tools]]')
  })

  it('leaves files with no matching link unchanged, including changed=false', () => {
    const files: GardenFile[] = [{ name: 'a.md', content: '[[Unrelated Note]]' }]

    const [result] = rewriteWikilinks(files, 'Tools for Thinking', 'Thinking Tools')

    expect(result.changed).toBe(false)
    expect(result.content).toBe('[[Unrelated Note]]')
  })

  it('rewrites every matching link across multiple files independently', () => {
    const files: GardenFile[] = [
      { name: 'a.md', content: '[[Old]]' },
      { name: 'b.md', content: 'no link here' },
      { name: 'c.md', content: '[[old]] and [[Old|display]]' },
    ]

    const results = rewriteWikilinks(files, 'Old', 'New')

    expect(results.find((r) => r.name === 'a.md')!.content).toBe('[[New]]')
    expect(results.find((r) => r.name === 'b.md')!.changed).toBe(false)
    expect(results.find((r) => r.name === 'c.md')!.content).toBe(
      '[[New]] and [[New|display]]'
    )
  })
})

describe('renameNoteEverywhere', () => {
  it('renames the file, updates frontmatter title, and rewrites inbound links elsewhere', async () => {
    const source = new FakeGardenSource({
      'tools-for-thinking.md': note('Tools for Thinking', 'Body of the note.'),
      'other.md': note('Other', 'Mentions [[Tools for Thinking]] and [[tools-for-thinking]].'),
      'unrelated.md': note('Unrelated', 'No links here.'),
    })

    const summary = await renameNoteEverywhere(
      source,
      'tools-for-thinking.md',
      'Thinking Tools'
    )

    expect(summary.renamedFile).toBe(titleToFileName('Thinking Tools'))
    expect(summary.updatedFiles).toEqual(['other.md'])

    const renamed = await source.read('thinking-tools.md')
    expect(renamed).not.toBeNull()
    const { frontMatter, body } = parseNote(renamed!)
    expect(frontMatter.title).toBe('Thinking Tools')
    expect(body.trim()).toBe('Body of the note.')

    // The old filename is gone.
    expect(await source.read('tools-for-thinking.md')).toBeNull()

    // Both link forms in the other file were rewritten.
    const other = await source.read('other.md')
    expect(other).toContain('[[Thinking Tools]] and [[Thinking Tools]]')

    const unrelated = await source.read('unrelated.md')
    expect(unrelated).toContain('No links here.')
  })

  it('rewrites a self-referencing link inside the renamed note itself', async () => {
    const source = new FakeGardenSource({
      'old.md': note('Old', 'See also [[Old|this very note]].'),
    })

    await renameNoteEverywhere(source, 'old.md', 'New')

    const content = await source.read('new.md')
    expect(content).toContain('[[New|this very note]]')
  })

  it('keeps the filename and frontmatter title from drifting apart', async () => {
    const source = new FakeGardenSource({
      'weird name.md': note('Weird Name', 'body'),
    })

    const summary = await renameNoteEverywhere(source, 'weird name.md', 'Totally New Title')

    const files = await source.list()
    const renamedFile = files.find((f) => f.name === summary.renamedFile)!
    const { frontMatter } = parseNote(renamedFile.content)

    expect(titleToFileName(frontMatter.title)).toBe(summary.renamedFile)
    expect(frontMatter.title).toBe('Totally New Title')
  })

  it('refuses to rename onto an existing note', async () => {
    const source = new FakeGardenSource({
      'a.md': note('A', 'body'),
      'b.md': note('B', 'body'),
    })

    await expect(renameNoteEverywhere(source, 'a.md', 'B')).rejects.toThrow()
  })

  it('is a no-op rewrite for files unrelated to the renamed title', async () => {
    const source = new FakeGardenSource({
      'a.md': note('A', 'body'),
      'unrelated.md': note('Unrelated', 'Links to [[Something Else]] only.'),
    })

    const summary = await renameNoteEverywhere(source, 'a.md', 'A Renamed')

    expect(summary.updatedFiles).toEqual([])
    const unrelated = await source.read('unrelated.md')
    expect(unrelated).toContain('[[Something Else]]')
  })
})
