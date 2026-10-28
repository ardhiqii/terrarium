import type { Maturity } from './game/types'

export type ContentType = 'note' | 'project'

export interface FrontMatter {
  title: string
  date: string
  description: string
  tags: string[]
  type: ContentType
  image?: string
  /** How settled this note is. Absent means 'seedling'. */
  maturity?: Maturity
}

export interface ContentMeta extends FrontMatter {
  slug: string
  /** e.g. "notes" or "projects" */
  collection: string
  /** full url path e.g. /notes/my-slug */
  href: string
}

export interface ContentItem extends ContentMeta {
  content: string
}

export interface GraphNode {
  id: string
  label: string
  href: string
  type: ContentType
  val?: number
  /** Count of incoming wikilinks. Drives node size, the hub signal. */
  backlinkCount: number
  /** Absent means 'seedling', same convention as MaturityMark. Notes only. */
  maturity?: Maturity
  /**
   * Frontmatter tags. Carried so the graph can be filtered without re-reading the corpus
   * client-side; the filter runs in the browser and a filter that has to call the server to
   * discover its own options is not a filter.
   */
  tags: string[]
}

export interface GraphLink {
  source: string
  target: string
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}
