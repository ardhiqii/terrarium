import { describe, expect, it, vi } from 'vitest'
import {
  PROTOTYPE_COMPANION_CATALOG,
  type CompanionDefinition,
} from './companion-catalog'
import {
  buildPokeApiPokemonUrl,
  buildPokeApiSpeciesUrl,
} from './pokemon-provider'
import {
  describeCompanionAsset,
  resolveCompanionAsset,
  resolveCompanionAssetFromCache,
  isCompanionCacheEntryIdentityValid,
} from './companion-asset-resolver'
import { resolveCompanionAssetWithProvider } from './companion-asset-provider-resolver'
import type { PokeApiCacheEntry } from './sprites/pokeapi-pure'

const grass = PROTOTYPE_COMPANION_CATALOG.get('grass-family')!
const pikachu = PROTOTYPE_COMPANION_CATALOG.get('pikachu-family')!

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

function staleEntry(overrides: Partial<PokeApiCacheEntry> = {}): PokeApiCacheEntry {
  return {
    id: 999,
    url: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/999.gif',
    staticUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/999.png',
    animated: true,
    width: 96,
    height: 96,
    pokemonName: 'old-species',
    speciesName: 'old-species',
    evolutionChainId: 999,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('companion asset descriptors and resolvers', () => {
  it('maps Grass forms to the canonical Bulbasaur family identities', () => {
    const sporeling = describeCompanionAsset(grass, 'sporeling')
    const mossling = describeCompanionAsset(grass, 'mossling')
    const bracken = describeCompanionAsset(grass, 'bracken')
    const heartwood = describeCompanionAsset(grass, 'heartwood')

    expect(sporeling.identity.expectedPokemonId).toBe(1)
    expect(sporeling.provider.entityId).toBe('bulbasaur')
    expect(mossling.identity.expectedPokemonId).toBe(2)
    expect(mossling.provider.entityId).toBe('ivysaur')
    expect(bracken.identity.expectedPokemonId).toBe(3)
    expect(bracken.provider.entityId).toBe('venusaur')
    expect(heartwood.identity.expectedPokemonId).toBe(10033)
    expect(heartwood.provider.entityId).toBe('venusaur-mega')
  })

  it('maps Pikachu base and evolved forms without borrowing the Grass line', () => {
    const base = resolveCompanionAsset(pikachu, 'base')
    const evolved = resolveCompanionAsset(pikachu, 'evolved')

    expect(base.identity.expectedPokemonId).toBe(25)
    expect(base.remote?.animatedUrl).toContain('/animated/25.gif')
    expect(base.remote?.staticUrl).toContain('/pokemon/25.png')
    expect(evolved.identity.expectedPokemonId).toBe(26)
    expect(evolved.remote?.animatedUrl).toContain('/animated/26.gif')
    expect(evolved.remote?.staticUrl).toContain('/pokemon/26.png')
    expect(base.remote?.source).toBe('derived')
  })

  it('prefers a valid cached animation and retains its static counterpart', () => {
    const resolved = resolveCompanionAssetFromCache(grass, 'mossling')

    expect(resolved.remote?.source).toBe('cache')
    expect(resolved.remote?.animatedUrl).toContain('/animated/2.gif')
    expect(resolved.remote?.staticUrl).toContain('/pokemon/2.png')
    expect(resolved.remote?.width).toBeGreaterThan(0)
    expect(resolved.remote?.height).toBeGreaterThan(0)
  })

  it('uses a cached static asset when the provider has no animation', () => {
    const resolved = resolveCompanionAssetFromCache(grass, 'mossling', {
      cacheEntry: staleEntry({
        id: 2,
        url: 'https://cdn.example.test/ivysaur.png',
        staticUrl: null,
        animated: false,
        pokemonName: 'ivysaur',
        evolutionChainId: 1,
      }),
    })

    expect(resolved.remote?.animatedUrl).toBeNull()
    expect(resolved.remote?.staticUrl).toBe('https://cdn.example.test/ivysaur.png')
  })

  it('keeps Heartwood/Mega static even when a cache record claims animation', () => {
    const resolved = resolveCompanionAssetFromCache(grass, 'heartwood', {
      cacheEntry: staleEntry({
        id: 10033,
        pokemonName: 'venusaur-mega',
        evolutionChainId: 1,
        url: 'https://cdn.example.test/venusaur-mega.gif',
        staticUrl: 'https://cdn.example.test/venusaur-mega.png',
        animated: true,
      }),
    })

    expect(resolved.remote?.source).toBe('cache')
    expect(resolved.remote?.animatedUrl).toBeNull()
    expect(resolved.remote?.staticUrl).toBe('https://cdn.example.test/venusaur-mega.png')
  })

  it('rejects stale line/stage cache identity and derives the current expected id', () => {
    const resolved = resolveCompanionAssetFromCache(grass, 'mossling', {
      cacheEntry: staleEntry(),
    })

    expect(resolved.remote?.source).toBe('derived')
    expect(resolved.remote?.animatedUrl).toContain('/animated/2.gif')
    expect(resolved.remote?.animatedUrl).not.toContain('/animated/999.gif')
    expect(resolved.remote?.staticUrl).toContain('/pokemon/2.png')
  })

  it('rejects same-id cache data when the cached species or chain is stale', () => {
    const descriptor = describeCompanionAsset(grass, 'mossling')
    expect(
      isCompanionCacheEntryIdentityValid(
        descriptor,
        staleEntry({ id: 2, pokemonName: 'oddish', evolutionChainId: 1 }),
      ),
    ).toBe(false)
    expect(
      isCompanionCacheEntryIdentityValid(
        descriptor,
        staleEntry({ id: 2, pokemonName: 'ivysaur', evolutionChainId: 87 }),
      ),
    ).toBe(false)
  })

  it('refreshes a stale cache entry through the provider and accepts only matching identity', async () => {
    const pokemonUrl = buildPokeApiPokemonUrl('ivysaur')
    const speciesUrl = buildPokeApiSpeciesUrl('ivysaur')
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === pokemonUrl) {
        return response({
          id: 2,
          name: 'ivysaur',
          is_default: true,
          species: { name: 'ivysaur', url: speciesUrl },
          forms: [{ name: 'ivysaur', url: 'https://pokeapi.co/api/v2/pokemon-form/2/' }],
          sprites: {
            front_default: 'https://raw.githubusercontent.com/PokeAPI/sprites/2.png',
            versions: {
              'generation-v': {
                'black-white': {
                  animated: {
                    front_default: 'https://raw.githubusercontent.com/PokeAPI/sprites/2.gif',
                  },
                },
              },
            },
          },
        })
      }
      if (url === speciesUrl) {
        return response({ evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/1/' } })
      }
      return response(null, false)
    }) as unknown as typeof globalThis.fetch

    const resolved = await resolveCompanionAssetWithProvider(grass, 'mossling', {
      cacheEntry: staleEntry(),
      fetch,
    })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(resolved.remote?.source).toBe('provider')
    expect(resolved.remote?.animatedUrl).toBe('https://raw.githubusercontent.com/PokeAPI/sprites/2.gif')
    expect(resolved.remote?.staticUrl).toBe('https://raw.githubusercontent.com/PokeAPI/sprites/2.png')
  })

  it('uses the local code-generated sprite when provider refresh fails', async () => {
    const fetch = vi.fn(async () => response(null, false)) as unknown as typeof globalThis.fetch
    const resolved = await resolveCompanionAssetWithProvider(grass, 'mossling', {
      cacheEntry: staleEntry(),
      fetch,
    })

    expect(resolved.remote).toBeNull()
    expect(resolved.local.id).toBe('mossling')
  })

  it('respects a catalog form that is explicitly static-only', () => {
    const ditto = PROTOTYPE_COMPANION_CATALOG.get('ditto-like')!
    const resolved = resolveCompanionAsset(ditto, 'base')

    expect(resolved.remote?.animatedUrl).toBeNull()
    expect(resolved.remote?.staticUrl).toContain('/pokemon/132.png')
  })

  it('falls back locally for a non-PokeAPI provider without inventing a URL', () => {
    const artistDefinition: CompanionDefinition = {
      ...grass,
      id: 'artist-family',
      familyId: 'artist-family',
      forms: [
        {
          ...grass.forms[0],
          provider: { providerId: 'artist:studio', entityId: 'mossling-form' },
        },
      ],
      progression: [
        { ...grass.progression[0], formId: grass.forms[0].id },
      ],
    }
    const resolved = resolveCompanionAsset(artistDefinition, 'sporeling')

    expect(resolved.remote).toBeNull()
    expect(resolved.local.id).toBe('sporeling')
  })
})

