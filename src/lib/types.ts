export type ContentType = 'note' | 'project'

export interface FrontMatter {
  title: string
  date: string
  description: string
  tags: string[]
  type: ContentType
  image?: string
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
}

export interface GraphLink {
  source: string
  target: string
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}
