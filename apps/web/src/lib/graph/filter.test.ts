import { describe, expect, it } from 'vitest'
import { filterGraph } from './filter'
import type { GraphData, GraphNode } from '@/lib/types'

function node(id: string, tags: string[], maturity?: GraphNode['maturity']): GraphNode {
  return { id, label: id, href: `/${id}`, type: 'note', val: 1, backlinkCount: 0, maturity, tags }
}

/** a-b-c-d chain: a(evergreen, systems+dx) b(seedling, systems) c(unset, dx) d(budding, pkm) */
const data: GraphData = {
  nodes: [
    node('a', ['systems', 'dx'], 'evergreen'),
    node('b', ['systems'], 'seedling'),
    node('c', ['dx']),
    node('d', ['pkm'], 'budding'),
  ],
  links: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' },
  ],
}

describe('filterGraph', () => {
  it('returns the whole garden when nothing is filtered', () => {
    const out = filterGraph(data, 'all', 'all')
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(out.links).toHaveLength(3)
  })

  it('keeps only nodes carrying the tag', () => {
    const out = filterGraph(data, 'systems', 'all')
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('drops links whose far end was filtered out', () => {
    const out = filterGraph(data, 'systems', 'all')
    // a->b survives; b->c and c->d would draw into nothing
    expect(out.links).toEqual([{ source: 'a', target: 'b' }])
  })

  it('treats an unset maturity as seedling', () => {
    const out = filterGraph(data, 'all', 'seedling')
    expect(out.nodes.map((n) => n.id)).toEqual(['b', 'c'])
  })

  it('filters by an explicit maturity', () => {
    const out = filterGraph(data, 'all', 'evergreen')
    expect(out.nodes.map((n) => n.id)).toEqual(['a'])
  })

  it('applies tag and maturity together', () => {
    const out = filterGraph(data, 'dx', 'evergreen')
    expect(out.nodes.map((n) => n.id)).toEqual(['a'])
    expect(out.links).toHaveLength(0)
  })

  /**
   * The regression this file exists for.

   * react-force-graph rewrites link.source/target from string ids into node objects in place
   * once the simulation starts. A filter that assumes strings passes on first render and
   * silently returns zero links on every render after it, which is exactly the kind of bug
   * that only shows up after the user touches the control twice.
   */
  it('still resolves endpoints after the simulation has mutated them into objects', () => {
    const mutated = {
      nodes: data.nodes,
      links: [
        { source: { id: 'a' }, target: { id: 'b' } },
        { source: { id: 'c' }, target: { id: 'd' } },
      ],
    } as unknown as GraphData

    const out = filterGraph(mutated, 'systems', 'all')
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(out.links).toHaveLength(1)
  })

  it('returns an empty graph instead of a half graph when nothing matches', () => {
    const out = filterGraph(data, 'pkm', 'evergreen')
    expect(out.nodes).toHaveLength(0)
    expect(out.links).toHaveLength(0)
  })
})
