import type { CompanionDefinition } from './companion-catalog'
import {
  describeCompanionAsset,
  withCompanionRemoteAsset,
  type CompanionAssetDescriptor,
  type CompanionRemoteAsset,
} from './companion-asset-descriptor'
import {
  DEFAULT_COMPANION_REMOTE_HEIGHT,
  DEFAULT_COMPANION_REMOTE_WIDTH,
  resolveCompanionAssetFromCache,
  type ResolveCompanionAssetOptions,
} from './companion-asset-resolver'
import { buildStaticSpriteUrl } from './sprites/pokeapi-pure'
import type { PokeApiResolution } from './pokemon-provider'
import {
  isPokeApiReferenceIdentityMatch,
  resolvePokeApiReference,
  type ResolvePokeApiOptions,
} from './pokemon-provider'

export interface ResolveCompanionAssetWithProviderOptions
  extends ResolveCompanionAssetOptions,
    Pick<ResolvePokeApiOptions, 'fetch'> {}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
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

function remoteFromProvider(
  descriptor: CompanionAssetDescriptor,
  resolution: PokeApiResolution | null,
): CompanionRemoteAsset | null {
  if (
    !resolution ||
    !isPokeApiReferenceIdentityMatch(descriptor.provider, resolution.metadata)
  ) {
    return null
  }

  const expectedId = descriptor.identity.expectedPokemonId
  const animatedUrl = animatedAllowed(descriptor)
    ? safeHttpsUrl(resolution.sprites.animatedUrl)
    : null
  const staticUrl =
    safeHttpsUrl(resolution.sprites.staticUrl) ??
    (expectedId !== null ? buildStaticSpriteUrl(expectedId) : null)

  // A motion-safe static representation is required before exposing an
  // animated URL. Otherwise reduced-motion visitors would have no safe image
  // to select and the renderer correctly falls back to the local sprite.
  if (!animatedUrl && !staticUrl) return null
  return {
    animatedUrl,
    staticUrl,
    width: DEFAULT_COMPANION_REMOTE_WIDTH,
    height: DEFAULT_COMPANION_REMOTE_HEIGHT,
    source: 'provider',
  }
}

/**
 * Server/provider boundary for a companion asset. Valid cache hits are used
 * without a network request. Cache misses and identity mismatches are
 * refreshed through the provider; a failed or mismatched refresh returns the
 * descriptor's local fallback rather than stale remote art.
 */
export async function resolveCompanionAssetWithProvider(
  definition: CompanionDefinition,
  formId: string,
  options: ResolveCompanionAssetWithProviderOptions = {},
): Promise<CompanionAssetDescriptor> {
  const cacheResolved = resolveCompanionAssetFromCache(definition, formId, options)
  if (cacheResolved.remote?.source === 'cache') return cacheResolved

  const descriptor = describeCompanionAsset(definition, formId)
  const form = definition.forms.find((candidate) => candidate.id === formId)
  if (!form || form.provider.providerId !== 'pokeapi') return descriptor

  try {
    const resolution = await resolvePokeApiReference(form.provider, {
      fetch: options.fetch,
    })
    return withCompanionRemoteAsset(descriptor, remoteFromProvider(descriptor, resolution))
  } catch {
    return descriptor
  }
}

/** Explicit name for server-rendered callers. */
export const resolveCompanionAssetServer = resolveCompanionAssetWithProvider

