import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { ContentMeta, ContentItem, FrontMatter } from './types'

const CONTENT_ROOT = path.join(process.cwd(), 'apps', 'web', 'content')

const COLLECTIONS = ['notes', 'projects'] as const
type Collection = (typeof COLLECTIONS)[number]

function getCollection(collection: Collection): string {
  return path.join(CONTENT_ROOT, collection)
}

function readFileMeta(filePath: string, collection: Collection): ContentMeta {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const { data } = matter(raw)
  const fm = data as FrontMatter
  const slug = path.basename(filePath, '.mdx')
  return {
    ...fm,
    tags: fm.tags ?? [],
    slug,
    collection,
    href: `/${collection}/${slug}`,
  }
}

function readFileItem(filePath: string, collection: Collection): ContentItem {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const { data, content } = matter(raw)
  const fm = data as FrontMatter
  const slug = path.basename(filePath, '.mdx')
  return {
    ...fm,
    tags: fm.tags ?? [],
    slug,
    collection,
    href: `/${collection}/${slug}`,
    content,
  }
}

function getFilePaths(collection: Collection): string[] {
  const dir = getCollection(collection)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => path.join(dir, f))
}

/** Get all content metadata (no raw content) sorted by date desc */
export function getAllContent(): ContentMeta[] {
  const items: ContentMeta[] = []
  for (const collection of COLLECTIONS) {
    for (const filePath of getFilePaths(collection)) {
      items.push(readFileMeta(filePath, collection))
    }
  }
  return items.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  )
}

/** Get all content from a specific collection */
export function getCollectionContent(collection: Collection): ContentMeta[] {
  return getFilePaths(collection)
    .map((fp) => readFileMeta(fp, collection))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

/** Get a single content item by collection + slug */
export function getContentItem(
  collection: Collection,
  slug: string
): ContentItem | null {
  const filePath = path.join(getCollection(collection), `${slug}.mdx`)
  if (!fs.existsSync(filePath)) return null
  return readFileItem(filePath, collection)
}

/** Get all slugs for static generation */
export function getAllSlugs(
  collection: Collection
): { slug: string }[] {
  return getFilePaths(collection).map((fp) => ({
    slug: path.basename(fp, '.mdx'),
  }))
}

/** Get all unique tags across all content */
export function getAllTags(): string[] {
  const all = getAllContent()
  const tagSet = new Set<string>()
  for (const item of all) {
    for (const tag of item.tags) tagSet.add(tag)
  }
  return Array.from(tagSet).sort()
}

/** Get content filtered by tag */
export function getContentByTag(tag: string): ContentMeta[] {
  return getAllContent().filter((item) => item.tags.includes(tag))
}
