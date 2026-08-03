import { getAllContent } from './content'
import { buildBacklinksMap } from './backlinks'
import { GraphData, GraphNode, GraphLink } from './types'

export function buildGraphData(): GraphData {
  const allContent = getAllContent()
  const backlinksMap = buildBacklinksMap()

  const nodes: GraphNode[] = allContent.map((item) => ({
    id: item.slug,
    label: item.title,
    href: item.href,
    type: item.type,
    val: 1,
    backlinkCount: backlinksMap.get(item.slug)?.length ?? 0,
    maturity: item.maturity,
  }))

  const links: GraphLink[] = []
  const seen = new Set<string>()

  for (const [targetSlug, sources] of backlinksMap.entries()) {
    for (const source of sources) {
      const key = `${source.slug}→${targetSlug}`
      if (!seen.has(key)) {
        seen.add(key)
        links.push({ source: source.slug, target: targetSlug })
      }
    }
  }

  return { nodes, links }
}
