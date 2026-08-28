import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { extractWikilinks, slugify } from './utils'
import { ContentMeta } from './types'

const CONTENT_ROOT = path.join(process.cwd(), 'apps', 'web', 'content')
const COLLECTIONS = ['notes', 'projects'] as const

interface FileInfo {
  slug: string
  collection: string
  title: string
  rawContent: string
}

function getAllFiles(): FileInfo[] {
  const files: FileInfo[] = []
  for (const collection of COLLECTIONS) {
    const dir = path.join(CONTENT_ROOT, collection)
    if (!fs.existsSync(dir)) continue
    const mdxFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.mdx'))
    for (const f of mdxFiles) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8')
      const { data, content } = matter(raw)
      files.push({
        slug: path.basename(f, '.mdx'),
        collection,
        title: data.title ?? path.basename(f, '.mdx'),
        rawContent: content,
      })
    }
  }
  return files
}

/**
 * Build a map: slug → array of ContentMeta items that link TO that slug.
 */
export function buildBacklinksMap(): Map<string, ContentMeta[]> {
  const files = getAllFiles()

  // Build a title→(slug,collection) lookup
  const titleToFile = new Map<string, { slug: string; collection: string }>()
  for (const f of files) {
    titleToFile.set(f.title.toLowerCase(), { slug: f.slug, collection: f.collection })
    // also index by slug (for [[slug]] style links)
    titleToFile.set(f.slug.toLowerCase(), { slug: f.slug, collection: f.collection })
  }

  const backlinks = new Map<string, ContentMeta[]>()

  for (const file of files) {
    const linkedTitles = extractWikilinks(file.rawContent)
    for (const linkedTitle of linkedTitles) {
      const key = linkedTitle.toLowerCase()
      const slugKey = slugify(linkedTitle).toLowerCase()

      const target = titleToFile.get(key) ?? titleToFile.get(slugKey)
      if (!target) continue

      const targetKey = target.slug
      if (!backlinks.has(targetKey)) {
        backlinks.set(targetKey, [])
      }

      // Add the linking file as a backlink (avoid duplicates)
      const existing = backlinks.get(targetKey)!
      const alreadyAdded = existing.some((e) => e.slug === file.slug)
      if (!alreadyAdded) {
        existing.push({
          title: file.title,
          slug: file.slug,
          collection: file.collection,
          href: `/${file.collection}/${file.slug}`,
          date: '',
          description: '',
          tags: [],
          type: file.collection === 'notes' ? 'note' : 'project',
        })
      }
    }
  }

  return backlinks
}

/**
 * Get backlinks for a specific slug.
 */
export function getBacklinks(slug: string): ContentMeta[] {
  const map = buildBacklinksMap()
  return map.get(slug) ?? []
}

/**
 * Resolve [[Title]] → href for use in MDX rendering.
 * Returns a map of wikilinkTitle → href.
 */
export function buildWikilinkMap(): Map<string, string> {
  const files = getAllFiles()
  const map = new Map<string, string>()
  for (const f of files) {
    map.set(f.title.toLowerCase(), `/${f.collection}/${f.slug}`)
    map.set(f.slug.toLowerCase(), `/${f.collection}/${f.slug}`)
  }
  return map
}
