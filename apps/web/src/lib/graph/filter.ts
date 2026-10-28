import type { GraphData } from '@/lib/types'
import type { Maturity } from '@/lib/game/types'
import { endpointId } from './endpoints'

export type MaturityFilter = 'all' | Maturity

const ALL = 'all'

/**
 * Keep the nodes that survive BOTH filters, then keep only the links whose two ends survived.
 *
 * Dropping a node without dropping its edges leaves the force engine drawing lines into
 * nothing, which reads as corrupt data rather than as a filter. Endpoints go through endpointId()
 * because the simulation rewrites them from ids to objects in place; a naive `keep.has(link.source)`
 * passes on the first render and fails on every one after it.
 *
 * Pure and dependency-free so the filter is testable without mounting a force graph.
 */
export function filterGraph(data: GraphData, tag: string, maturity: MaturityFilter): GraphData {
  const nodes = data.nodes.filter((node) => {
    if (tag !== ALL && !node.tags.includes(tag)) return false
    // Absent maturity means 'seedling', the same convention as MaturityMark and GraphNode.
    if (maturity !== ALL && (node.maturity ?? 'seedling') !== maturity) return false
    return true
  })

  const keep = new Set(nodes.map((node) => node.id))
  const links = data.links.filter((link) => {
    const from = endpointId((link as { source: unknown }).source)
    const to = endpointId((link as { target: unknown }).target)
    return from !== undefined && to !== undefined && keep.has(from) && keep.has(to)
  })

  return { nodes, links }
}
