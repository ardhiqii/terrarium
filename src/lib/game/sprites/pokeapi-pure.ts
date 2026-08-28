/**
 * Pure, browser-safe half of the PokeAPI sprite adapter. This module reads
 * the committed `pokeapi-cache.json` as a plain data import -- no `fs`, no
 * `path`, no network -- so it is safe to import from anything reachable by a
 * `'use client'` component. The fs-backed half that writes/refreshes that
 * cache at build time lives in `pokeapi.ts`, which imports the shared
 * constants and helpers from here rather than duplicating them.
 *
 * This is the fix for the sprite mismatch between the server-rendered home
 * page (renders through `pokeapi.ts` -> PokeAPI GIF) and the client-rendered
 * `/garden` workspace, which previously could not touch `pokeapi.ts` at all
 * because importing it drags `node:fs` into the client bundle. Since the
 * cache is already committed to the repo, resolving a stage's sprite is just
 * a lookup into already-known data -- no filesystem or network access
 * required at read time.
 */
import cacheData from './pokeapi-cache.json'
import type { SpriteData, StageId } from '../types'
import { DEFAULT_SPECIES_LINE_ID } from './species'
import { getSprite } from './index'

export interface PokeApiCacheEntry {
  id: number
  url: string
  /** The static sprite URL returned by PokeAPI, when one exists. */
  staticUrl?: string | null
  /** True when `url` is an animated GIF rather than a still image. */
  animated?: boolean
  width: number
  height: number
  /** PokeAPI identity fields, retained so a companion can explain its origin. */
  pokemonName?: string
  speciesName?: string
  formName?: string
  isDefaultForm?: boolean
  evolutionChainId?: number | null
  fetchedAt: string
}

/**
 * Keyed by `${lineId}:${stage}` (e.g. `'grass:mossling'`), matching
 * `pokeapi.ts`'s on-disk cache shape exactly -- this is the same file,
 * just reached via a static import instead of `fs.readFileSync`.
 */
type PokeApiCache = Partial<Record<string, PokeApiCacheEntry>>

const CACHE = cacheData as PokeApiCache

export function cacheKey(lineId: string, stage: StageId): string {
  return `${lineId}:${stage}`
}

export function buildSpriteUrl(id: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${id}.gif`
}

/**
 * The same Pokemon's plain, non-animated default sprite. Used as the
 * `prefers-reduced-motion: reduce` swap target, since a CSS media query
 * cannot pause a GIF once the browser starts decoding it.
 */
export function buildStaticSpriteUrl(id: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`
}

/**
 * Synchronous, cache-only lookup: never touches the network, never touches
 * `fs`. Returns null when this `(lineId, stage)` pair has not yet been
 * resolved and committed to `pokeapi-cache.json`, exactly mirroring what the
 * server-side resolver returns before it would have gone to the network.
 */
export function getPokeApiSpriteForLineFromCache(
  lineId: string,
  stage: StageId
): PokeApiCacheEntry | null {
  return CACHE[cacheKey(lineId, stage)] ?? null
}

/** A sprite resolved to something renderable. Mirrors `source.ts`'s type. */
export type ResolvedSprite =
  | { kind: 'data'; data: SpriteData }
  | {
      kind: 'remote'
      url: string
      staticUrl: string | null
      width: number
      height: number
      animated: boolean
    }

/**
 * The client-safe counterpart to `resolveWithFallback` (`source.ts`): tries
 * the committed PokeAPI cache first, falls back to the local code-generated
 * sprite, exactly the same fallback order the server uses, just without the
 * network leg (the browser never fetches-and-caches new PokeAPI entries;
 * only the build-time `pokeapi.ts` path does that). This is what lets
 * `/garden` render the identical animated creature as the home page for any
 * stage that has already been resolved into the cache.
 */
export function resolvePureSpriteWithFallback(
  stage: StageId,
  lineId: string = DEFAULT_SPECIES_LINE_ID
): ResolvedSprite {
  const entry = getPokeApiSpriteForLineFromCache(lineId, stage)
  if (entry) {
    return {
      kind: 'remote',
      url: entry.url,
      staticUrl: entry.staticUrl ?? (entry.id <= 649 ? buildStaticSpriteUrl(entry.id) : null),
      width: entry.width,
      height: entry.height,
      // Older committed cache entries predate the metadata fields. They all
      // point at the animated GIF path, so this default keeps them valid.
      animated: entry.animated ?? true,
    }
  }

  const data = getSprite(stage)
  if (data) return { kind: 'data', data }

  // Unreachable in practice (every StageId has a code-generated sprite);
  // matches `resolveWithFallback`'s own last-resort branch.
  return {
    kind: 'data',
    data: { id: stage, width: 1, height: 1, palette: ['transparent'], frames: [['0']] },
  }
}
