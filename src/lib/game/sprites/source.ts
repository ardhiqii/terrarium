/**
 * Sprite source abstraction. `CreatureSprite` renders through this rather
 * than talking to `getSprite()` or PokeAPI directly, so swapping the primary
 * art source later (original pixel art instead of PokeAPI) is a one-adapter
 * change instead of a rewrite. See ROADMAP.md, sprite art decision.
 */
import type { StageId, SpriteData } from '../types'
import { getSprite } from './index'
import { getPokeApiSpriteForLine, buildStaticSpriteUrl } from './pokeapi'
import { DEFAULT_SPECIES_LINE_ID } from './species'

/** A sprite resolved to something renderable. */
export type ResolvedSprite =
  | { kind: 'data'; data: SpriteData }
  | {
      kind: 'remote'
      url: string
      /**
       * A non-animated still of the same sprite, present whenever `animated`
       * is true. `prefers-reduced-motion: reduce` cannot pause a GIF by
       * itself, so callers that care about that preference (`CreatureSprite`)
       * swap to this instead of `url`.
       */
      staticUrl: string | null
      width: number
      height: number
      animated: boolean
    }

export interface SpriteSource {
  readonly id: string
  /** Never throws. Returns null when this source cannot supply the stage. */
  resolve(stage: StageId): Promise<ResolvedSprite | null>
}

/**
 * A `SpriteSource` bound to one species line. `resolveWithFallback` builds
 * one of these per call when a caller passes a `lineId`, so every repo
 * creature's sprite resolution goes through the same fallback machinery as
 * the default line, just pointed at a different set of PokeAPI ids.
 */
function pokeApiSourceForLine(lineId: string): SpriteSource {
  return {
    id: `pokeapi:${lineId}`,
    async resolve(stage) {
      try {
        const entry = await getPokeApiSpriteForLine(lineId, stage)
        if (!entry) return null
        return {
          kind: 'remote',
          url: entry.url,
          staticUrl: buildStaticSpriteUrl(entry.id),
          width: entry.width,
          height: entry.height,
          animated: true,
        }
      } catch {
        return null
      }
    },
  }
}

/**
 * Wraps the existing code-generated sprites. This is the guaranteed
 * fallback: it never throws and never returns null for a valid stage, since
 * every stage has a code-generated sprite defined in `creatures.ts`.
 */
export const LocalSpriteSource: SpriteSource = {
  id: 'local',
  async resolve(stage) {
    try {
      const data = getSprite(stage)
      if (!data) return null
      return { kind: 'data', data }
    } catch {
      return null
    }
  },
}

/**
 * Maps stages onto animated Generation-V PokeAPI sprites. Metadata is cached
 * to `pokeapi-cache.json`; see `pokeapi.ts` for the fair-use rationale.
 * Never throws: any failure resolves to `null` so `resolveWithFallback` can
 * fall through to `LocalSpriteSource`.
 */
export const PokeApiSpriteSource: SpriteSource = pokeApiSourceForLine(DEFAULT_SPECIES_LINE_ID)

/** Ordered source list. PokeApi first, Local last as the guaranteed fallback. */
export const SPRITE_SOURCES: SpriteSource[] = [PokeApiSpriteSource, LocalSpriteSource]

/**
 * Tries sources in order, first non-null wins. Never throws.
 *
 * `lineId` picks which species line's PokeAPI ids to resolve against
 * (default `grass`, the GARDEN creature's line). Ignored when an explicit
 * `sources` list is passed, since that list already pins its own sources.
 */
export async function resolveWithFallback(
  stage: StageId,
  sources?: SpriteSource[],
  lineId: string = DEFAULT_SPECIES_LINE_ID
): Promise<ResolvedSprite> {
  const resolvedSources =
    sources ?? [pokeApiSourceForLine(lineId), LocalSpriteSource]

  for (const source of resolvedSources) {
    try {
      const resolved = await source.resolve(stage)
      if (resolved) return resolved
    } catch {
      // A source must never throw, but guard anyway: one misbehaving source
      // must not take down the whole resolution chain.
    }
  }

  // Guaranteed last resort, in case even LocalSpriteSource was omitted from
  // a custom `sources` list or somehow returned null.
  const local = await LocalSpriteSource.resolve(stage)
  if (local) return local

  // Should be unreachable: every StageId has a code-generated sprite. Return
  // an empty data sprite rather than throwing, per the "never throws" contract.
  return {
    kind: 'data',
    data: { id: stage, width: 1, height: 1, palette: ['transparent'], frames: [['0']] },
  }
}
