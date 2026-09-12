import { describe, expect, it } from 'vitest'
import {
  summarizeFiles,
  sameSummary,
  changedFiles,
  hashContent,
  type SourceScanSummary,
} from './scan-summary'

const files = [
  { path: 'a.md', content: 'hello world', modifiedAt: '2026-09-12T08:00:00Z' },
  { path: 'sub/b.md', content: 'two words here', modifiedAt: '2026-09-12T09:00:00Z' },
]

describe('scan-summary', () => {
  it('hashes content deterministically and differently for different text', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'))
    expect(hashContent('hello')).not.toBe(hashContent('world'))
  })

  it('summarizes without retaining content', () => {
    const summary = summarizeFiles('vault-1', files, '2026-09-12T10:00:00Z')
    expect(summary.sourceId).toBe('vault-1')
    expect(summary.files).toHaveLength(2)
    // Sorted by path, and no content field survives.
    expect(summary.files[0].path).toBe('a.md')
    expect(summary.files[0].contentHash).toBe(hashContent('hello world'))
    expect('content' in summary.files[0]).toBe(false)
  })

  it('detects identical vs changed summaries', () => {
    const one = summarizeFiles('v1', files, '2026-09-12T10:00:00Z')
    const same = summarizeFiles('v1', files, '2026-09-12T10:00:00Z')
    expect(sameSummary(one.files, same.files)).toBe(true)

    const edited = files.map((f) => (f.path === 'a.md' ? { ...f, content: 'hello world edited' } : f))
    const two = summarizeFiles('v1', edited, '2026-09-12T10:00:00Z')
    expect(sameSummary(one.files, two.files)).toBe(false)
  })

  it('reports added, modified, and deleted files', () => {
    const before = summarizeFiles('v1', [
      { path: 'a.md', content: 'aaa', modifiedAt: '2026-09-12T08:00:00Z' },
      { path: 'b.md', content: 'bbb', modifiedAt: '2026-09-12T08:00:00Z' },
    ], '2026-09-12T09:00:00Z')

    const after = summarizeFiles('v1', [
      { path: 'a.md', content: 'aaaa', modifiedAt: '2026-09-12T08:00:00Z' }, // modified
      { path: 'c.md', content: 'ccc', modifiedAt: '2026-09-12T08:30:00Z' }, // added
      // b.md removed
    ], '2026-09-12T10:00:00Z')

    expect(changedFiles(before.files, after.files).sort()).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('is order-independent because summaries are sorted by path', () => {
    const a = summarizeFiles('v1', files.sort((x, y) => x.path.localeCompare(y.path)), 't')
    const b = summarizeFiles('v1', [...files].reverse(), 't')
    expect(sameSummary(a.files, b.files)).toBe(true)
  })
})
