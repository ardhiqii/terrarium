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

/**
 * Extracts all [[wikilink]] targets from raw MDX content.
 * Returns an array of titles (not slugs).
 */
export function extractWikilinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g
  const links: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

/**
 * Given a title, returns the [[wikilink]] pattern used in MDX.
 */
export function wikilinkToSlug(title: string): string {
  return slugify(title)
}
