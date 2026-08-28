/**
 * Converts a title to a URL-friendly slug.
 * "My Cool Idea" → "my-cool-idea"
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Matches a `[[wikilink]]`, capturing everything between the brackets. */
export const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g

export interface ParsedWikilink {
  /** The link target, with any `|alias` suffix removed. */
  target: string
  /** The text to display. Falls back to `target` when no alias is given. */
  label: string
}

/**
 * Parses the inside of a `[[wikilink]]`, supporting the `[[Target|alias]]`
 * form used across the garden.
 *
 * A target may legitimately contain no pipe, so everything after the first
 * pipe is treated as the alias, and an empty alias falls back to the target.
 */
export function parseWikilink(raw: string): ParsedWikilink {
  const pipeIndex = raw.indexOf('|')
  if (pipeIndex === -1) {
    const target = raw.trim()
    return { target, label: target }
  }
  const target = raw.slice(0, pipeIndex).trim()
  const alias = raw.slice(pipeIndex + 1).trim()
  return { target, label: alias || target }
}

/**
 * Extracts all [[wikilink]] targets from raw MDX content.
 * Returns an array of titles (not slugs), with `|alias` suffixes stripped.
 */
export function extractWikilinks(content: string): string[] {
  const links: string[] = []
  let match: RegExpExecArray | null
  WIKILINK_REGEX.lastIndex = 0
  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
    const { target } = parseWikilink(match[1])
    if (target) links.push(target)
  }
  return links
}

/**
 * Given a title, returns the [[wikilink]] pattern used in MDX.
 */
export function wikilinkToSlug(title: string): string {
  return slugify(title)
}
