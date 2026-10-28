import type { GraphNode } from '@/lib/types'

/**
 * Resolve a link endpoint to its node id.
 *
 * react-force-graph mutates link.source/link.target in place, replacing the string id with the
 * resolved node object once the force engine has initialised. Anything that reads a link has to
 * work whichever form is currently present, or it silently breaks only after the first render.
 * That timing is why this lives here rather than at each call site: two consumers now need it
 * (the graph render itself and the filter in front of it) and they must agree.
 */
export function endpointId(x: unknown): string | undefined {
  if (!x) return undefined
  if (typeof x === 'string') return x
  return (x as GraphNode).id
}
