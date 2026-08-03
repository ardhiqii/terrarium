/**
 * Disk-reading wrapper around cluster detection.
 *
 * All the actual logic lives in `clusters-from-items.ts`, which has no `fs`
 * dependency and therefore runs in a browser. This file only reads `content/`
 * from disk and delegates.
 *
 * The split is load-bearing, not cosmetic: this module imports `../backlinks`,
 * which requires `fs` at module scope. Any client component importing from
 * here drags `fs` into the browser bundle and the page fails to render. Server
 * callers import from here; browser callers import from
 * `clusters-from-items.ts` directly.
 *
 * Re-exported below so existing server-side consumers and the unmodified test
 * suite keep working against `./clusters`.
 */

import { getAllContent, getContentItem } from '../content'
import { buildBacklinksMap } from '../backlinks'
import { ContentItem } from '../types'
import { detectClustersFrom, type Cluster } from './clusters-from-items'

export {
  detectClustersFrom,
  CLUSTER_THRESHOLD,
  type Cluster,
} from './clusters-from-items'

/**
 * Reads `content/` from disk and delegates. Zero behaviour change from before
 * the split; see `clusters.test.ts`, unmodified.
 */
export function detectClusters(): Cluster[] {
  const all = getAllContent()
  const items: ContentItem[] = all.map((meta) => {
    const item = getContentItem(meta.collection as 'notes' | 'projects', meta.slug)
    return { ...meta, content: item?.content ?? '' }
  })
  const backlinksMap = buildBacklinksMap()
  return detectClustersFrom(items, backlinksMap)
}
