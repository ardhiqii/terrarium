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
 * Splits a wikilink target into the page it names and an optional `#anchor`.
 *
 * WHY THIS EXISTS: `[[Note#Heading]]` is one page plus a section heading. The XP resolver
 * (`markdown-events.ts`) already trims the anchor before matching a note, but the backlink and
 * statistic paths did not, so an anchored link earned XP while resolving to nothing for
 * backlinks, `resolvedWikilinks`, and the cluster map — and the MDX renderer linked it to
 * `#note-heading`, an in-page anchor that does not exist.
 *
 * DELIBERATELY NOT DONE IN `parseWikilink`: the editor stores `target` verbatim on its node and
 * re-serialises it, so trimming there would silently drop the anchor the next time the user
 * opens and saves the note.
 */
export function splitWikilinkTarget(raw: string): { target: string; anchor: string } {
  const hashIndex = raw.indexOf('#')
  if (hashIndex === -1) return { target: raw.trim(), anchor: '' }
  return {
    target: raw.slice(0, hashIndex).trim(),
    anchor: raw.slice(hashIndex + 1).trim(),
  }
}

/**
 * Extracts all [[wikilink]] targets from raw MDX content.
 * Returns page names (not slugs), with `|alias` and `#anchor` suffixes stripped.
 */
export function extractWikilinks(content: string): string[] {
  const links: string[] = []
  let match: RegExpExecArray | null
  WIKILINK_REGEX.lastIndex = 0
  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
    const { target } = parseWikilink(match[1])
    const { target: page } = splitWikilinkTarget(target)
    if (page) links.push(page)
  }
  return links
}

/**
 * Given a title, returns the [[wikilink]] pattern used in MDX.
 */
export function wikilinkToSlug(title: string): string {
  return slugify(title)
}
