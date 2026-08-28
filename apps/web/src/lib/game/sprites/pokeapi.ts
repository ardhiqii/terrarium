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
 * The original adapter assumed every asset was a default-form Generation-V
 * animated sprite. That is not true for alternate forms: PokeAPI can expose
 * a form with a static sprite but no animated one. The resolver therefore
 * asks the Pokémon endpoint for the authoritative URLs and only uses the
 * old Generation-V URL as a compatibility fallback for default IDs.
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

/**
 * Keyed by `${lineId}:${stage}` (e.g. `'grass:mossling'`), not just `stage`,
 * now that a stage can resolve to a different Pokemon id depending on which
 * species line it belongs to. `cacheKey` (from `pokeapi-pure.ts`) builds
 * this consistently, shared with the read-only client-side lookup.
 */
type PokeApiCache = Partial<Record<string, PokeApiCacheEntry>>

const CACHE_PATH = path.join(process.cwd(), 'apps/web/src/lib/game/sprites/pokeapi-cache.json')

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

function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  const pngSignature = '89504e470d0a1a0a'
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== pngSignature) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function readImageDimensions(buf: Buffer, contentType: string): { width: number; height: number } | null {
  if (contentType.includes('gif') && buf.length >= 10 && buf.subarray(0, 3).toString() === 'GIF') {
    return readGifDimensions(buf)
  }
  return readPngDimensions(buf)
}

interface PokeApiPokemonRecord {
  name?: unknown
  id?: unknown
  is_default?: unknown
  species?: { name?: unknown; url?: unknown }
  forms?: Array<{ name?: unknown }>
  sprites?: {
    front_default?: unknown
    versions?: {
      'generation-v'?: {
        'black-white'?: { animated?: { front_default?: unknown } }
      }
    }
  }
}

interface PokeApiSpeciesRecord {
  evolution_chain?: { url?: unknown }
}

function getIdFromUrl(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = value.match(/\/(\d+)\/?$/)
  return match ? Number(match[1]) : null
}

async function fetchPokemonRecord(id: number): Promise<PokeApiPokemonRecord | null> {
  try {
    const response = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`)
    if (!response.ok) return null
    const record = (await response.json()) as PokeApiPokemonRecord
    return record && typeof record === 'object' ? record : null
  } catch {
    return null
  }
}

async function fetchSpeciesRecord(url: unknown): Promise<PokeApiSpeciesRecord | null> {
  if (typeof url !== 'string') return null
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const record = (await response.json()) as PokeApiSpeciesRecord
    return record && typeof record === 'object' ? record : null
  } catch {
    return null
  }
}

/**
 * Resolves a stage, within a given species line, to cached PokeAPI sprite
 * metadata. Reads the on-disk cache first and only reaches the network when
 * this exact `(lineId, stage)` pair has never been resolved before. The
 * Pokémon endpoint supplies form/evolution metadata and the best available
 * asset URL. Never throws: any failure resolves to `null` so the caller can
 * fall back to local sprites.
 */
export async function getPokeApiSpriteForLine(
  lineId: string,
  stage: StageId,
  idOverride?: number
): Promise<PokeApiCacheEntry | null> {
  const cache = readCache()
  const key = cacheKey(lineId, stage)
  const cached = cache[key]
  // Refresh the small legacy cache once so old entries gain form/evolution
  // metadata. After that, this remains a true cache-first path.
  if (
    cached &&
    typeof cached.animated === 'boolean' &&
    typeof cached.pokemonName === 'string' &&
    'evolutionChainId' in cached
  ) {
    return cached
  }

  const id = idOverride ?? getSpeciesLine(lineId).stageToPokemonId[stage]
  if (id === undefined || !Number.isInteger(id) || id < 1) return null

  try {
    const record = await fetchPokemonRecord(id)
    const animatedUrl =
      typeof record?.sprites?.versions?.['generation-v']?.['black-white']?.animated?.front_default ===
      'string'
        ? record.sprites.versions['generation-v']['black-white'].animated.front_default
        : null
    const apiStaticUrl = typeof record?.sprites?.front_default === 'string' ? record.sprites.front_default : null
    const url = animatedUrl ?? apiStaticUrl ?? (id <= 649 ? buildSpriteUrl(id) : null)
    if (!url) return null

    const res = await fetch(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const dimensions = readImageDimensions(buf, res.headers.get('content-type') ?? '')
    if (!dimensions?.width || !dimensions.height) return null

    const species = await fetchSpeciesRecord(record?.species?.url)
    const evolutionChainId = getIdFromUrl(species?.evolution_chain?.url)

    const entry: PokeApiCacheEntry = {
      id,
      url,
      staticUrl: apiStaticUrl,
      animated: Boolean(animatedUrl),
      width: dimensions.width,
      height: dimensions.height,
      pokemonName: typeof record?.name === 'string' ? record.name : undefined,
      speciesName: typeof record?.species?.name === 'string' ? record.species.name : undefined,
      formName: typeof record?.forms?.[0]?.name === 'string' ? record.forms[0].name : undefined,
      isDefaultForm: typeof record?.is_default === 'boolean' ? record.is_default : undefined,
      // The species response links to the evolution-chain endpoint. Keep the
      // field nullable for malformed/partial API responses; resolving the
      // sprite must not fail just because metadata is incomplete.
      evolutionChainId,
      fetchedAt: new Date().toISOString(),
    }
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
