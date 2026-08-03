/**
 * PokeAPI adapter: maps evolution stages to Generation-V animated sprites and
 * caches resolved metadata to `pokeapi-cache.json` so builds never re-hit the
 * network once a stage has been resolved once.
 *
 * PokeAPI's fair-use policy requires local caching of anything requested from
 * their infrastructure ("Locally cache resources whenever you request them"),
 * and the documented penalty for ignoring it is a permanent IP ban. Treat the
 * cache-first behaviour here as a hard requirement, not an optimisation.
 *
 * Animated sprites only exist for the generation-v black-white set, which
 * only covers Pokemon ids 1 through 649. Never map a stage to an id above
 * that range.
 *
 * This is the fs-backed half of the adapter: it writes/refreshes the
 * on-disk cache at build time. `pokeapi-pure.ts` holds the client-safe half
 * (url builders, cache-only lookup) that this module imports rather than
 * duplicates -- see that file's header for why the split exists.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { StageId } from '../types'
import {
  DEFAULT_SPECIES_LINE_ID,
  MAX_ANIMATED_POKEMON_ID,
  getSpeciesLine,
} from './species'
import {
  buildSpriteUrl,
  buildStaticSpriteUrl,
  cacheKey,
  type PokeApiCacheEntry,
} from './pokeapi-pure'

export { buildStaticSpriteUrl }

/**
 * The original single-line mapping, preserved as a convenience alias onto
 * the `grass` entry of `SPECIES_LINES` (species.ts). This is the line the
 * GARDEN creature (the site owner's own creature, driven by notes plus
 * commits) always renders through: it never goes through species
 * assignment, so it must render exactly as it did before T19 widened the
 * pool. Repo creatures resolve through `getPokeApiSpriteForLine` instead,
 * picking whichever line `species-assign.ts` assigned them.
 */
export const STAGE_TO_POKEMON_ID: Record<StageId, number> =
  getSpeciesLine(DEFAULT_SPECIES_LINE_ID).stageToPokemonId

const MAX_ANIMATED_ID = MAX_ANIMATED_POKEMON_ID

/**
 * Keyed by `${lineId}:${stage}` (e.g. `'grass:mossling'`), not just `stage`,
 * now that a stage can resolve to a different Pokemon id depending on which
 * species line it belongs to. `cacheKey` (from `pokeapi-pure.ts`) builds
 * this consistently, shared with the read-only client-side lookup.
 */
type PokeApiCache = Partial<Record<string, PokeApiCacheEntry>>

const CACHE_PATH = path.join(process.cwd(), 'src/lib/game/sprites/pokeapi-cache.json')

let cacheMemo: PokeApiCache | null = null
/** Tracks whether any entry was added this process, so we only write once. */
let cacheDirty = false

function readCache(): PokeApiCache {
  if (cacheMemo) return cacheMemo
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8')
    cacheMemo = JSON.parse(raw) as PokeApiCache
  } catch {
    cacheMemo = {}
  }
  return cacheMemo
}

function writeCache(cache: PokeApiCache): void {
  try {
    fs.writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf-8')
  } catch {
    // Best-effort. A failed write just means this process re-fetches next
    // time; it must never break the build.
  }
}

/**
 * Reads the GIF's logical screen descriptor (bytes 6-9, little-endian) to get
 * true pixel dimensions without a dependency. Avoids guessing sprite size,
 * which varies per Pokemon in this sprite set.
 */
function readGifDimensions(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

/**
 * Resolves a stage, within a given species line, to cached PokeAPI sprite
 * metadata. Reads the on-disk cache first and only reaches the network when
 * this exact `(lineId, stage)` pair has never been resolved before. Never
 * throws: any failure (network down, bad response, malformed GIF) resolves
 * to `null` so the caller can fall back to local sprites.
 */
export async function getPokeApiSpriteForLine(
  lineId: string,
  stage: StageId,
  idOverride?: number
): Promise<PokeApiCacheEntry | null> {
  const cache = readCache()
  const key = cacheKey(lineId, stage)
  const cached = cache[key]
  if (cached) return cached

  const id = idOverride ?? getSpeciesLine(lineId).stageToPokemonId[stage]
  if (id === undefined || id < 1 || id > MAX_ANIMATED_ID) return null

  try {
    const url = buildSpriteUrl(id)
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const { width, height } = readGifDimensions(buf)
    if (!width || !height) return null

    const entry: PokeApiCacheEntry = { id, url, width, height, fetchedAt: new Date().toISOString() }
    cache[key] = entry
    cacheDirty = true
    writeCache(cache)
    return entry
  } catch {
    return null
  }
}

/**
 * Back-compat entry point for the default (`grass`) line, used by the
 * GARDEN creature so its call site does not need to know about species
 * lines at all.
 */
export async function getPokeApiSprite(stage: StageId): Promise<PokeApiCacheEntry | null> {
  return getPokeApiSpriteForLine(DEFAULT_SPECIES_LINE_ID, stage)
}

/** Exposed for tests/tooling that want to know whether a fetch happened. */
export function wasCacheWrittenThisProcess(): boolean {
  return cacheDirty
}
