/**
 * Derives `GardenStats` from the existing content, backlinks, and graph
 * libraries. Pure measurement, no XP math (see `xp.ts` for that).
 *
 * The actual measurement logic lives in `stats-from-items.ts`'s
 * `getGardenStatsFrom()`, which has no dependency on `fs` and can run in a
 * browser (T23). This file is now a thin wrapper: read `content/` from disk,
 * build a `ContentItem[]`, delegate. Zero behaviour change from before the
 * split -- see `stats.test.ts`, unmodified.
 */

import { getAllContent, getContentItem } from '../content'
import { buildBacklinksMap } from '../backlinks'
import { ContentItem } from '../types'
import { GardenStats } from './types'
import { getGardenStatsFrom } from './stats-from-items'

export { getGardenStatsFrom, buildBacklinksMapFromItems } from './stats-from-items'

export function getGardenStats(): GardenStats {
  const all = getAllContent()

  const items: ContentItem[] = all.map((meta) => {
    const item = getContentItem(meta.collection as 'notes' | 'projects', meta.slug)
    return { ...meta, content: item?.content ?? '' }
  })

  // Keep calling the real, disk-reading buildBacklinksMap() rather than
  // letting getGardenStatsFrom recompute one from `items`: this is what
  // stats.test.ts mocks and asserts against, and the two are equivalent for
  // real content, so this preserves both correctness and the existing test
  // suite unmodified.
  const backlinksMap = buildBacklinksMap()

  return getGardenStatsFrom(items, backlinksMap)
}
