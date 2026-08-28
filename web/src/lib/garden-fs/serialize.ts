/**
 * Frontmatter <-> file text for the editor.
 *
 * The whole point of this file: the round trip must produce ordinary,
 * standard-YAML frontmatter over plain markdown, so a file written by this
 * editor is indistinguishable from one written by hand and opens cleanly in
 * Obsidian tomorrow. No proprietary syntax, no editor-specific metadata.
 *
 * Uses `gray-matter`, already a project dependency and the same library
 * `src/lib/backlinks.ts` and the MDX pipeline read frontmatter with, so the
 * shape stays consistent across the whole codebase instead of introducing a
 * second YAML implementation.
 */

import matter from 'gray-matter'
import { MATURITIES, type Maturity } from '../game/types'
import { slugify } from '../utils'

/** Frontmatter fields the editor exposes as form fields, never raw YAML. */
export interface NoteFrontMatter {
  title: string
  /** ISO date, e.g. "2026-08-01". */
  date: string
  tags: string[]
  /** Absent means 'seedling', same convention as the rest of the garden. */
  maturity?: Maturity
}

export interface ParsedNote {
  frontMatter: NoteFrontMatter
  /** Body markdown, frontmatter stripped, no leading/trailing blank padding. */
  body: string
}

/** Filename (with `.md`) a title serialises to. Rename must keep this and
 *  `frontMatter.title` derived from the same source so they cannot drift. */
export function titleToFileName(title: string): string {
  return `${slugify(title)}.md`
}

/** Strips the extension a `GardenFile.name` carries, `.md` or `.mdx` alike. */
export function fileNameToSlug(name: string): string {
  return name.replace(/\.mdx?$/i, '')
}

/**
 * Turns form-field frontmatter plus a markdown body into the full file text
 * that gets written to disk. Field order is fixed so diffs stay stable
 * across saves.
 */
export function serializeNote(frontMatter: NoteFrontMatter, body: string): string {
  const data: Record<string, unknown> = {
    title: frontMatter.title,
    date: frontMatter.date,
    tags: [...frontMatter.tags],
  }
  if (frontMatter.maturity) {
    data.maturity = frontMatter.maturity
  }

  const trimmedBody = body.replace(/^\n+/, '').replace(/\s+$/, '')
  const bodyWithTrailingNewline = trimmedBody.length > 0 ? `${trimmedBody}\n` : ''

  return matter.stringify(bodyWithTrailingNewline, data)
}

function isValidMaturity(value: unknown): value is Maturity {
  return typeof value === 'string' && (MATURITIES as readonly string[]).includes(value)
}

/** Parses raw file text (as read from a `GardenSource`) into form fields
 *  plus body. Tolerant of missing/malformed frontmatter: a file with none
 *  round-trips as an empty title rather than throwing, since a user's own
 *  folder may contain notes this editor did not create. */
export function parseNote(raw: string): ParsedNote {
  const { data, content } = matter(raw)

  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t): t is string => typeof t === 'string')
    : []

  return {
    frontMatter: {
      title: typeof data.title === 'string' ? data.title : '',
      date: typeof data.date === 'string' ? data.date : '',
      tags,
      maturity: isValidMaturity(data.maturity) ? data.maturity : undefined,
    },
    body: content.replace(/^\n+/, ''),
  }
}
