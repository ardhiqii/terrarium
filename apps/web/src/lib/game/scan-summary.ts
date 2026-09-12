/**
 * Compact, privacy-preserving scan summary for a mounted Markdown source.
 *
 * WHY: the guest runtime currently keeps the full `MarkdownFileSnapshot`
 * (including each file's content) in memory and stores a baseline fingerprint
 * in the guest profile. That means a large vault is effectively held twice in
 * the browser (once in the scan, once as snapshots). PRODUCT.md and DESIGN.md
 * both say local note content must never be uploaded and should stay local;
 * this module gives us a compact per-file summary so we can detect what changed
 * between scans (while the site is closed) WITHOUT keeping a second copy of
 * note text.
 *
 * A summary stores only: path, byte size, content hash, and modification time.
 * No note body, no frontmatter, no words, no tags. Two summaries compare by
 * these stable signals, so a later scan can tell "this file changed" without
 * having the old text around.
 */

export interface FileScanSummary {
  path: string
  /** UTF-8 byte length of the file content, for cheap change detection. */
  size: number
  /**
   * Stable content hash (FNV-1a, hex). Collisions are acceptable for a
   * change signal; this is not a cryptographic digest.
   */
  contentHash: string
  /** ISO modification time. */
  modifiedAt: string
}

/** The compact per-source state, stored instead of full file content. */
export interface SourceScanSummary {
  sourceId: string
  files: readonly FileScanSummary[]
  observedAt: string
}

/** FNV-1a 32-bit, hex string. Same family as the repo's other hash usage. */
export function hashContent(content: string): string {
  let hash = 2166136261
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

/** Build a compact summary from a set of raw Markdown file snapshots. */
export function summarizeFiles(
  sourceId: string,
  files: ReadonlyArray<{ path: string; content: string; modifiedAt: string }>,
  observedAt: string
): SourceScanSummary {
  const ordered = [...files]
    .map((file) => {
      const path = file.path.trim().replaceAll('\\', '/')
      const size = new TextEncoder().encode(file.content).byteLength
      const contentHash = hashContent(file.content)
      const modifiedAt = new Date(file.modifiedAt).toISOString()
      return { path, size, contentHash, modifiedAt }
    })
    .sort((left, right) => left.path.localeCompare(right.path))

  return { sourceId, files: ordered, observedAt }
}

/** True when two summaries are identical in every tracked signal. */
export function sameSummary(
  left: ReadonlyArray<FileScanSummary>,
  right: ReadonlyArray<FileScanSummary>
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a.path !== b.path) return false
    if (a.size !== b.size) return false
    if (a.contentHash !== b.contentHash) return false
    if (a.modifiedAt !== b.modifiedAt) return false
  }
  return true
}

/** Which files changed between two ordered summaries (by path). */
export function changedFiles(
  previous: ReadonlyArray<FileScanSummary>,
  current: ReadonlyArray<FileScanSummary>
): string[] {
  const byPath = new Map(current.map((file) => [file.path, file]))
  const changed = new Set<string>()

  for (const prev of previous) {
    const now = byPath.get(prev.path)
    if (!now) {
      changed.add(prev.path) // deleted
      continue
    }
    if (now.size !== prev.size || now.contentHash !== prev.contentHash) {
      changed.add(prev.path) // modified
    }
  }

  for (const cur of current) {
    const hadPrev = previous.some((file) => file.path === cur.path)
    if (!hadPrev) changed.add(cur.path) // added
  }

  return [...changed].sort()
}
