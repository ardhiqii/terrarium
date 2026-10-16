import type { CompanionDefinition } from './companion-catalog'
import {
  describeCompanionAsset,
  withCompanionRemoteAsset,
  type CompanionAssetDescriptor,
  type CompanionRemoteAsset,
} from './companion-asset-descriptor'
import {
  buildSpriteUrl,
  buildStaticSpriteUrl,
  getPokeApiSpriteForLineFromCache,
  type PokeApiCacheEntry,
} from './sprites/pokeapi-pure'
import { STAGES, type StageId } from './types'
export const DEFAULT_COMPANION_REMOTE_WIDTH = 96
export const DEFAULT_COMPANION_REMOTE_HEIGHT = 96

export type CompanionAssetCacheLookup = (
  lineId: string,
  stage: StageId,
) => PokeApiCacheEntry | null

export interface ResolveCompanionAssetOptions {
  /** Injectable cache lookup for deterministic tests and future manifests. */
  cacheLookup?: CompanionAssetCacheLookup
  /** Direct cache fixture override, useful for migration/cache tests. */
  cacheEntry?: PokeApiCacheEntry | null
  /** Optional line key when a future catalog definition has no legacyLine. */
  cacheLineId?: string
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function safeDimension(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function normalizedName(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

function expectedStage(
  definition: CompanionDefinition,
  formId: string,
): StageId | null {
  const index = definition.progression.findIndex((step) => step.formId === formId)
  if (index < 0) return null
  return STAGES[Math.min(index, STAGES.length - 1)].id
}

function cacheEntryFor(
  definition: CompanionDefinition,
  descriptor: CompanionAssetDescriptor,
  options: ResolveCompanionAssetOptions,
): PokeApiCacheEntry | null {
  if (options.cacheEntry !== undefined) return options.cacheEntry
  const lineId = options.cacheLineId ?? definition.legacyLine
  const stage = expectedStage(definition, descriptor.formId)
  if (!lineId || !stage || descriptor.provider.providerId !== 'pokeapi') return null
  const lookup = options.cacheLookup ?? getPokeApiSpriteForLineFromCache
  try {
    return lookup(lineId, stage)
  } catch {
    return null
  }
}

/**
 * Verify both halves of the cache key: the current catalog's expected numeric
 * entity and, when present, the cached provider name/chain. A line/stage key
 * alone is not identity. This rejects a stale cache entry after a catalog
 * remap instead of silently showing the old species.
 */
export function isCompanionCacheEntryIdentityValid(
  descriptor: CompanionAssetDescriptor,
  entry: PokeApiCacheEntry,
): boolean {
  if (descriptor.provider.providerId !== 'pokeapi') return false
  const expectedId = descriptor.identity.expectedPokemonId
  if (expectedId === null || entry.id !== expectedId) return false

  const expectedName = normalizedName(descriptor.provider.entityId)
  if (entry.pokemonName !== undefined && normalizedName(entry.pokemonName) !== expectedName) {
    return false
  }

  const expectedChain = descriptor.provider.metadata?.evolutionChainId
  if (
    typeof expectedChain === 'number' &&
    entry.evolutionChainId !== expectedChain
  ) {
    return false
  }

  return true
}

function animatedAllowed(descriptor: CompanionAssetDescriptor): boolean {
  const expectedId = descriptor.identity.expectedPokemonId
  return (
    descriptor.allowsAnimation &&
    descriptor.kind !== 'mastery' &&
    expectedId !== null &&
    expectedId <= 649
  )
}

function remoteFromCache(
  descriptor: CompanionAssetDescriptor,
  entry: PokeApiCacheEntry,
): CompanionRemoteAsset | null {
  if (!isCompanionCacheEntryIdentityValid(descriptor, entry)) return null

  const expectedId = descriptor.identity.expectedPokemonId
  const entryUrl = safeHttpsUrl(entry.url)
  const cachedStaticUrl = safeHttpsUrl(entry.staticUrl)
  // Cache entries written before the `animated` field existed are still
  // trustworthy when their URL is the known Generation-V GIF path. Treat
  // them as animated for the preferred path, but always derive a separate
  // still URL for reduced motion.
  const cacheClaimsAnimation =
    entry.animated === true ||
    (entry.animated === undefined && entryUrl?.toLowerCase().includes('.gif') === true)
  const animatedUrl =
    animatedAllowed(descriptor) && cacheClaimsAnimation && entryUrl?.toLowerCase().includes('.gif')
      ? entryUrl
      : null
  const staticUrl =
    cachedStaticUrl ??
    (!cacheClaimsAnimation && entryUrl ? entryUrl : null) ??
    (expectedId !== null ? buildStaticSpriteUrl(expectedId) : null)

  if (!animatedUrl && !staticUrl) return null
  return {
    animatedUrl,
    staticUrl,
    width: safeDimension(entry.width, DEFAULT_COMPANION_REMOTE_WIDTH),
    height: safeDimension(entry.height, DEFAULT_COMPANION_REMOTE_HEIGHT),
    source: 'cache',
  }
}

function derivedRemote(
  descriptor: CompanionAssetDescriptor,
): CompanionRemoteAsset | null {
  if (descriptor.provider.providerId !== 'pokeapi') return null
  const expectedId = descriptor.identity.expectedPokemonId
  if (expectedId === null) return null

  return {
    // The animated Generation-V set ends at National Dex 649. Heartwood/Mega
    // is deliberately static even if a malformed provider record claims an
    // animated URL.
    animatedUrl: animatedAllowed(descriptor) ? buildSpriteUrl(expectedId) : null,
    staticUrl: buildStaticSpriteUrl(expectedId),
    width: DEFAULT_COMPANION_REMOTE_WIDTH,
    height: DEFAULT_COMPANION_REMOTE_HEIGHT,
    source: 'derived',
  }
}

function descriptorWithCacheOrDerived(
  definition: CompanionDefinition,
  descriptor: CompanionAssetDescriptor,
  options: ResolveCompanionAssetOptions,
): CompanionAssetDescriptor {
  const entry = cacheEntryFor(definition, descriptor, options)
  const cached = entry ? remoteFromCache(descriptor, entry) : null
  return withCompanionRemoteAsset(descriptor, cached ?? derivedRemote(descriptor))
}

/**
 * Browser-safe, synchronous resolver. It reads only the committed cache and
 * deterministic provider URLs; it never imports fs/path and never performs a
 * network request. A non-PokeAPI or non-numeric provider reference leaves the
 * local generated sprite as the safe fallback; remote load failures are
 * handled by `CompanionSprite`.
 */
export function resolveCompanionAssetFromCache(
  definition: CompanionDefinition,
  formId: string,
  options: ResolveCompanionAssetOptions = {},
): CompanionAssetDescriptor {
  const descriptor = describeCompanionAsset(definition, formId)
  return descriptorWithCacheOrDerived(definition, descriptor, options)
}

/** Short name for client-safe callers. */
export const resolveCompanionAsset = resolveCompanionAssetFromCache

/** Re-export the form-id helper beside the resolver for runtime consumers. */
export { describeCompanionAsset }
