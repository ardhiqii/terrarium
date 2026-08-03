/**
 * Wikilink rewriting on rename.
 *
 * Wikilinks reference notes BY TITLE, not by a stable id, so a title is a key
 * living inside every other file that links to it. Rename a note without
 * rewriting and every inbound link dies silently: the build still passes,
 * pages still render, but links point nowhere, backlinks vanish, graph edges
 * disappear, and XP drops. Nobody notices for weeks. This file is the fix.
 *
 * Reuses `WIKILINK_REGEX` / `parseWikilink` from `src/lib/utils.ts` rather
 * than parsing wikilinks a second time here.
 */

import { WIKILINK_REGEX, parseWikilink, slugify } from '../utils'
import type { GardenFile, GardenSource } from './types'
import { parseNote, serializeNote, titleToFileName } from './serialize'

export interface RewriteResult {
  name: string
  content: string
  /** True when at least one wikilink in this file was rewritten. */
  changed: boolean
}

/**
 * Rewrites every `[[wikilink]]` across `files` that targets `oldTitle` so it
 * targets `newTitle` instead. A wikilink targets `oldTitle` when its target
 * (the part before an optional `|alias`) case-insensitively equals either
 * the old title itself or the old title's slug, matching how
 * `src/lib/backlinks.ts` and `src/lib/mdx.ts` resolve links today. Matching
 * is exact, never a substring: renaming "Tools for Thinking" must not touch
 * "Tools for Thinking Extended".
 *
 * Alias text (`[[Old|display text]]`) is preserved byte-for-byte; only the
 * target changes.
 */
export function rewriteWikilinks(
  files: GardenFile[],
  oldTitle: string,
  newTitle: string
): RewriteResult[] {
  const oldTitleLower = oldTitle.trim().toLowerCase()
  const oldSlugLower = slugify(oldTitle).toLowerCase()

  return files.map((file) => {
    let changed = false
    // WIKILINK_REGEX carries a `g` flag and lastIndex state; clone it per
    // file so files after the first in the array are not silently skipped.
    const regex = new RegExp(WIKILINK_REGEX.source, 'g')

    const content = file.content.replace(regex, (whole: string, inner: string) => {
      const { target } = parseWikilink(inner)
      const targetLower = target.toLowerCase()

      const matchesTitle = targetLower === oldTitleLower
      const matchesSlug = targetLower === oldSlugLower
      if (!matchesTitle && !matchesSlug) return whole

      changed = true

      const pipeIndex = inner.indexOf('|')
      if (pipeIndex === -1) {
        return `[[${newTitle}]]`
      }
      // Preserve the alias text exactly as written; only the target changes.
      const rawAlias = inner.slice(pipeIndex + 1)
      return `[[${newTitle}|${rawAlias}]]`
    })

    return { name: file.name, content, changed }
  })
}

export interface RenameSummary {
  /** The filename the note lives under after the rename. */
  renamedFile: string
  /** Filenames (other than the renamed note) whose wikilinks were rewritten. */
  updatedFiles: string[]
}

/**
 * Renames a note end to end: rewrites inbound (and self-referencing)
 * wikilinks across the whole folder, keeps the filename and the frontmatter
 * `title` derived from the same `newTitle` so they cannot drift, then moves
 * the bytes via `source.rename`.
 *
 * `GardenSource.rename` deliberately moves bytes only (see
 * `src/lib/garden-fs/types.ts`); link rewriting is the editor's job because
 * it needs to parse titles, which is exactly what this function does.
 */
export async function renameNoteEverywhere(
  source: GardenSource,
  oldFileName: string,
  newTitle: string
): Promise<RenameSummary> {
  const trimmedTitle = newTitle.trim()
  if (!trimmedTitle) {
    throw new Error('A note needs a title.')
  }

  const files = await source.list()
  const target = files.find((f) => f.name === oldFileName)
  if (!target) {
    throw new Error(`Note "${oldFileName}" not found.`)
  }

  const { frontMatter } = parseNote(target.content)
  const oldTitle = frontMatter.title || oldFileName.replace(/\.mdx?$/i, '')

  const newFileName = titleToFileName(trimmedTitle)
  if (newFileName !== oldFileName) {
    const collision = files.find((f) => f.name === newFileName)
    if (collision) {
      throw new Error(`A note named "${trimmedTitle}" already exists.`)
    }
  }

  const rewritten = rewriteWikilinks(files, oldTitle, trimmedTitle)
  const rewrittenByName = new Map(rewritten.map((r) => [r.name, r] as const))

  const updatedFiles: string[] = []
  for (const result of rewritten) {
    if (result.name === oldFileName) continue
    if (result.changed) {
      await source.write(result.name, result.content)
      updatedFiles.push(result.name)
    }
  }

  // The renamed note itself: apply any self-referencing wikilink rewrite,
  // then set the frontmatter title from the exact same `trimmedTitle` used
  // to derive the filename, so the two never drift apart.
  const selfResult = rewrittenByName.get(oldFileName)
  const selfContent = selfResult ? selfResult.content : target.content
  const { body: selfBody } = parseNote(selfContent)
  const newContent = serializeNote({ ...frontMatter, title: trimmedTitle }, selfBody)

  if (newFileName === oldFileName) {
    await source.write(oldFileName, newContent)
  } else {
    await source.rename(oldFileName, newFileName)
    await source.write(newFileName, newContent)
  }

  return { renamedFile: newFileName, updatedFiles }
}
