/**
 * Raw file text -> `ContentItem`, entirely in the browser.
 *
 * `gray-matter` (already a project dependency, used server-side by
 * `content.ts`/`backlinks.ts`) does NOT bundle for the client: its entry
 * point does `const fs = require('fs')` at module top level, unconditionally,
 * even though `fs` is only used by the `matter.read()` file-path convenience
 * method this project never calls. A bundler targeting the browser has no
 * `fs` to resolve. So this file implements its own small YAML-subset parser
 * covering exactly the frontmatter fields this project's `FrontMatter` type
 * uses (title, date, description, tags, type, maturity) rather than pulling
 * in a real YAML parser for six scalar/array fields.
 *
 * Missing frontmatter is the COMMON case, not an edge case -- an Obsidian
 * vault is full of plain notes with none at all. This never throws: a file
 * with no `---` block, a malformed block, or absent fields all resolve to
 * sane defaults (title derived from the filename, everything else empty).
 */
import { slugify } from '@/lib/utils'
import type { ContentItem, ContentType } from '@/lib/types'
import type { Maturity } from '@/lib/game/types'
import { MATURITIES } from '@/lib/game/types'
import type { GardenFile } from './types'

interface RawFrontMatter {
  title?: string
  date?: string
  description?: string
  tags?: string[]
  type?: string
  maturity?: string
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function parseInlineList(inner: string): string[] {
  return inner
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0)
}

/**
 * Parses the fields this project actually reads out of a YAML frontmatter
 * block: `key: value` scalars, `key: [a, b]` inline lists, and
 * `key:` followed by `- item` block lists (the two forms Obsidian and most
 * static-site generators produce for `tags`). Anything else -- nested maps,
 * multiline scalars, anchors -- is simply not a field this project uses, so
 * it is left unparsed rather than causing a throw.
 */
function parseFrontmatterBlock(block: string): RawFrontMatter {
  const data: RawFrontMatter = {}
  const lines = block.split(/\r?\n/)
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) {
      i += 1
      continue
    }

    const key = match[1].trim()
    const rawValue = match[2].trim()

    if (rawValue === '') {
      // Possible YAML block list on the following indented `- item` lines.
      const items: string[] = []
      let j = i + 1
      while (j < lines.length && /^\s*-\s*/.test(lines[j])) {
        items.push(stripQuotes(lines[j].replace(/^\s*-\s*/, '')))
        j += 1
      }
      if (items.length > 0 && key === 'tags') {
        data.tags = items
      }
      i = j > i + 1 ? j : i + 1
      continue
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const items = parseInlineList(rawValue.slice(1, -1))
      if (key === 'tags') data.tags = items
      i += 1
      continue
    }

    const value = stripQuotes(rawValue)
    switch (key) {
      case 'title':
        data.title = value
        break
      case 'date':
        data.date = value
        break
      case 'description':
        data.description = value
        break
      case 'type':
        data.type = value
        break
      case 'maturity':
        data.maturity = value
        break
      default:
        // Unrecognized field, ignored -- see file header.
        break
    }
    i += 1
  }

  return data
}

/**
 * Splits raw file text into frontmatter data and body, tolerating the
 * common case of no frontmatter block at all.
 */
export function parseFrontMatter(raw: string): { data: RawFrontMatter; content: string } {
  const match = raw.match(FRONTMATTER_BLOCK)
  if (!match) return { data: {}, content: raw }
  const data = parseFrontmatterBlock(match[1])
  const content = raw.slice(match[0].length)
  return { data, content }
}

/** Derives a readable title from a filename when frontmatter supplies none:
 * `my-cool-idea.md` -> `My Cool Idea`. This is the common path for a plain
 * Obsidian vault note. */
export function titleFromFilename(name: string): string {
  const base = name.replace(/\.(mdx|md)$/i, '')
  const spaced = base.replace(/[-_]+/g, ' ').trim()
  if (spaced.length === 0) return base
  return spaced.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1))
}

const MATURITY_SET = new Set<string>(MATURITIES)

function coerceMaturity(value: string | undefined): Maturity | undefined {
  if (!value) return undefined
  const lower = value.toLowerCase()
  return MATURITY_SET.has(lower) ? (lower as Maturity) : undefined
}

/**
 * Raw file text -> `ContentItem`. Never throws: a file with no frontmatter,
 * or malformed frontmatter, still parses to a usable item with defaults.
 *
 * A connected folder has no `notes/` vs `projects/` split the way this
 * repo's own `content/` does, so `collection` is derived from the
 * frontmatter `type` field (defaulting to `note`) rather than from a
 * directory name.
 */
export function parseGardenFile(file: GardenFile): ContentItem {
  const { data, content } = parseFrontMatter(file.content)

  const baseName = file.name.replace(/\.(mdx|md)$/i, '')
  const slug = slugify(baseName) || slugify(file.name) || file.name
  const title = data.title?.trim() || titleFromFilename(file.name)
  const type: ContentType = data.type === 'project' ? 'project' : 'note'
  const collection = type === 'project' ? 'projects' : 'notes'

  return {
    title,
    date: data.date ?? '',
    description: data.description ?? '',
    tags: data.tags ?? [],
    type,
    maturity: coerceMaturity(data.maturity),
    slug,
    collection,
    href: `/${collection}/${slug}`,
    content,
  }
}

/** Parses every file in a listing. A single malformed file never aborts the
 * batch: `parseGardenFile` itself cannot throw (see above), so this is a
 * plain map, kept as its own export so callers get one obvious entry point. */
export function parseGardenFiles(files: GardenFile[]): ContentItem[] {
  return files.map(parseGardenFile)
}
