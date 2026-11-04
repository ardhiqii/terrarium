/**
 * Which companion a repository is dressed with, as the public sees it.
 *
 * Read `docs-plan/PLAN-dressed-repo-creature.md` first. This is the pure half of
 * "show the dressed companion on the repo": it takes the owner's synced snapshot
 * and a GitHub repository id and returns the companion to display, or null. The
 * store reads, the opt-in check and the caching live in `dressed-repo-lookup.ts`,
 * so this file can be tested without a database and stays safe to import anywhere.
 *
 * THE SNAPSHOT IS USER-WRITTEN. It came from the owner's browser, so every rule
 * `repo-assignments.ts` enforces on write is enforced again here on read:
 *   - an assignment whose companion is not in the collection is ignored;
 *   - a companion spent on two repositories counts only for the first;
 *   - a repository listed twice keeps only the first assignment;
 *   - the species comes from the COLLECTION entry, not the assignment, so an
 *     assignment cannot claim a companion the user never drew.
 *
 * TWO ID FORMS, ONE COMPARISON. The snapshot hashes `collection[].referenceId`
 * but copies `assignments[].referenceId` verbatim, so both sides are compared in
 * their opaque form (`opaqueReferenceId` is idempotent).
 *
 * WHAT IS RETURNED IS EVERYTHING PUBLIC. No `referenceId`, no acquisition date,
 * no other collection entry: one companion, its stage and its XP.
 */

import {
  resolveCompanionProgression,
  type CompanionCatalog,
} from './companion-catalog'
import { resolveCompanionSprite, spriteIdForForm } from './companion-sprite'
import { buildStaticSpriteUrl } from './sprites/pokeapi-pure'
import { opaqueReferenceId, type ProductSnapshot } from '../sync/product-snapshot'

export interface DressedCompanion {
  /** Catalog id, e.g. `pikachu-family`. */
  readonly companionId: string
  /** Display name from the catalog, never user text. */
  readonly name: string
  readonly step: {
    readonly id: string
    readonly name: string
    /** 1-based, for "Stage 2 of 3". */
    readonly index: number
    readonly count: number
  }
  readonly xp: number
  readonly xpIntoStep: number
  /** Null at the final step. */
  readonly xpForNextStep: number | null
  /** 0..1 toward the next step; 1 at the final step. */
  readonly progress: number
  /** Animated GIF when the form has one, otherwise the still PNG. */
  readonly spriteUrl: string
  /** Always a still PNG, for reduced motion and for the SVG badge. */
  readonly stillUrl: string
  readonly animated: boolean
}

export type DressedSnapshot = Pick<ProductSnapshot, 'assignments' | 'collection' | 'companions'>

/**
 * The companion dressed on `repositoryId`, or null when it is not dressed or the
 * snapshot's claim does not hold up. Never throws.
 */
export function resolveDressedCompanion(
  snapshot: DressedSnapshot,
  repositoryId: string,
  catalog: CompanionCatalog,
): DressedCompanion | null {
  if (!repositoryId) return null

  const owned = new Map<string, string>() // opaque referenceId -> companionId
  for (const entry of snapshot.collection ?? []) {
    owned.set(opaqueReferenceId(entry.referenceId), entry.companionId)
  }

  // Replay the assignments in order, applying the read-side rule, until the
  // repository in question is reached.
  const spent = new Set<string>()
  const dressedRepos = new Set<string>()
  let companionId: string | null = null
  for (const assignment of snapshot.assignments ?? []) {
    const reference = opaqueReferenceId(assignment.referenceId)
    const ownedSpecies = owned.get(reference)
    if (ownedSpecies === undefined) continue
    if (spent.has(reference) || dressedRepos.has(assignment.repositoryId)) continue
    spent.add(reference)
    dressedRepos.add(assignment.repositoryId)
    if (assignment.repositoryId === repositoryId) {
      companionId = ownedSpecies
      break
    }
  }
  if (companionId === null) return null

  const definition = catalog.get(companionId)
  if (!definition) return null

  // XP follows the species (PRODUCT.md §6.5): two Pikachu share one ladder.
  const rawXp = snapshot.companions?.find((c) => c.companionId === companionId)?.xp ?? 0
  const xp = Number.isFinite(rawXp) ? Math.max(0, Math.floor(rawXp)) : 0

  let progression
  try {
    progression = resolveCompanionProgression(definition, xp)
  } catch {
    return null
  }

  const sprite = resolveCompanionSprite(definition, xp)
  const spriteId = spriteIdForForm(progression.form)
  if (!sprite || spriteId === null) return null

  const stepIndex = definition.progression.findIndex((step) => step.id === progression.step.id)

  return {
    companionId,
    name: definition.name,
    step: {
      id: progression.step.id,
      name: progression.step.name,
      index: stepIndex + 1,
      count: definition.progression.length,
    },
    xp,
    xpIntoStep: progression.xpIntoStep,
    xpForNextStep: progression.xpForNextStep,
    progress: progression.progress,
    spriteUrl: sprite.url,
    stillUrl: buildStaticSpriteUrl(spriteId),
    animated: sprite.animated,
  }
}
