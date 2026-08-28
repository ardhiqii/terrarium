/**
 * Assembles the single `CreatureState` object every creature surface
 * renders from. Computed once at build time.
 */

import { getGardenStats } from './stats'
import { getAllContent } from '../content'
import { composeCreatureState } from './repo-creature'
import { readGithubCache } from './github'
import { CreatureState, GithubStats } from './types'

/**
 * Days the owner published a note, for the Dew Vial streak.
 *
 * This read lives here rather than inside `items.ts`, which used to call
 * `getAllContent()` itself. That was a hidden dependency: it let the owner's
 * publish history leak into a stranger's unlock context, and it dragged `fs`
 * into any browser bundle importing the item system, which broke the
 * client-side garden. `state.ts` is a server-only module, so the read is safe
 * here and the data is passed in explicitly.
 */
function ownerNoteDays(): string[] {
  const days: string[] = []
  for (const item of getAllContent()) {
    if (!item.date) continue
    const t = new Date(item.date)
    if (!Number.isNaN(t.getTime())) days.push(t.toISOString().slice(0, 10))
  }
  return days
}

/**
 * The owner's creature: real garden stats plus commit XP, with items enabled.
 *
 * The XP assembly itself lives in `composeCreatureState` (repo-creature.ts) and
 * is deliberately NOT duplicated here. T6 originally mirrored this function's
 * arithmetic so the API could zero out garden stats for non-owner handles, which
 * left two copies of the same pipeline. Two copies means a future XP change has
 * to be made twice, and the owner's creature could silently start computing
 * differently from everyone else's. One assembly path, parameterized on stats.
 */
export function getCreatureState(
  github: GithubStats | null = null
): CreatureState {
  // Callers without their own GithubStats (or passing `null` explicitly, as the
  // home page does) fall back to whatever `github.ts` last cached to disk.
  // `readGithubCache` never throws and returns null when no cache exists.
  const resolvedGithub = github ?? readGithubCache()

  return composeCreatureState(getGardenStats(), resolvedGithub, {
    includeItems: true,
    ownerNoteDays: ownerNoteDays(),
  })
}
