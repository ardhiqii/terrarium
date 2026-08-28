import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPokeApiEvolutionChainUrl,
  buildPokeApiPokemonUrl,
  buildPokeApiSpeciesUrl,
  extractPokeApiEvolutionChainId,
  extractPokeApiFormIdentity,
  extractPokeApiSpriteUrls,
  resolvePokeApiReference,
  type PokeApiResolution,
} from './pokemon-provider'

const pokemonUrl = buildPokeApiPokemonUrl('pikachu')
const speciesUrl = buildPokeApiSpeciesUrl('pikachu')
const DITTO_CHAIN_ID = 87
const GIGANTAMAX_PIKACHU_ID = 10101

function response(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response
}

function mockFetch(routes: Readonly<Record<string, unknown>>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!(url in routes)) return response(null, false)
    return response(routes[url])
  }) as unknown as typeof fetch
}

function pikachuRoutes(): Readonly<Record<string, unknown>> {
  return {
    [pokemonUrl]: {
      id: 25,
      name: 'pikachu',
      is_default: true,
      species: { name: 'pikachu', url: speciesUrl },
      forms: [{ name: 'pikachu', url: 'https://pokeapi.co/api/v2/pokemon-form/25/' }],
      sprites: {
        front_default: 'https://raw.githubusercontent.com/PokeAPI/sprites/25.png',
        versions: {
          'generation-v': {
            'black-white': {
              animated: {
                front_default:
                  'https://raw.githubusercontent.com/PokeAPI/sprites/25.gif',
              },
            },
          },
        },
      },
    },
    [speciesUrl]: {
      evolution_chain: {
        url: buildPokeApiEvolutionChainUrl(10),
      },
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PokeAPI provider bridge', () => {
  it('builds browser-safe API URLs from opaque identifiers', () => {
    expect(buildPokeApiPokemonUrl('pikachu')).toBe(
      'https://pokeapi.co/api/v2/pokemon/pikachu',
    )
    expect(buildPokeApiSpeciesUrl(25)).toBe(
      'https://pokeapi.co/api/v2/pokemon-species/25',
    )
    expect(buildPokeApiEvolutionChainUrl(10)).toBe(
      'https://pokeapi.co/api/v2/evolution-chain/10',
    )
  })

  it('resolves Pikachu animation, static fallback data, form, and evolution chain', async () => {
    const fetch = mockFetch(pikachuRoutes())
    const result = await resolvePokeApiReference(
      {
        providerId: 'pokeapi',
        entityId: 'pikachu',
      },
      { fetch },
    )

    expect(result).not.toBeNull()
    expect(result?.sprites).toEqual({
      animatedUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/25.gif',
      staticUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/25.png',
      selectedUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/25.gif',
      selectedKind: 'animated',
    })
    expect(result?.metadata.form).toEqual({ id: '25', name: 'pikachu', isDefault: true })
    expect(result?.evolutionChainId).toBe(10)
    expect(result?.provider.metadata).toMatchObject({
      pokemonName: 'pikachu',
      speciesName: 'pikachu',
      evolutionChainId: 10,
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('resolves Ditto using its static sprite when no animation exists', async () => {
    const pokemon = buildPokeApiPokemonUrl('ditto')
    const species = buildPokeApiSpeciesUrl('ditto')
    const fetch = mockFetch({
      [pokemon]: {
        id: 132,
        name: 'ditto',
        is_default: true,
        species: { name: 'ditto', url: species },
        forms: [{ name: 'ditto', url: 'https://pokeapi.co/api/v2/pokemon-form/132/' }],
        sprites: { front_default: 'https://raw.githubusercontent.com/PokeAPI/sprites/132.png' },
      },
      [species]: { evolution_chain: { url: buildPokeApiEvolutionChainUrl(DITTO_CHAIN_ID) } },
    })

    const result = await resolvePokeApiReference(
      { providerId: 'pokeapi', entityId: 'ditto' },
      { fetch },
    )

    expect(result?.sprites.selectedKind).toBe('static')
    expect(result?.sprites.selectedUrl).toBe(
      'https://raw.githubusercontent.com/PokeAPI/sprites/132.png',
    )
    expect(result?.metadata.form.name).toBe('ditto')
  })

  it('keeps alternate-form identity separate from the default form', async () => {
    const pokemon = buildPokeApiPokemonUrl('pikachu-gmax')
    const species = buildPokeApiSpeciesUrl('pikachu')
    const fetch = mockFetch({
      [pokemon]: {
        id: GIGANTAMAX_PIKACHU_ID,
        name: 'pikachu-gmax',
        is_default: false,
        species: { name: 'pikachu', url: species },
        forms: [{ name: 'pikachu-gmax', url: 'https://pokeapi.co/api/v2/pokemon-form/10080/' }],
        sprites: {
          front_default: 'https://raw.githubusercontent.com/PokeAPI/sprites/gmax.png',
          versions: { 'generation-v': { 'black-white': { animated: { front_default: null } } } },
        },
      },
      [species]: { evolution_chain: { url: buildPokeApiEvolutionChainUrl(10) } },
    })

    const result = await resolvePokeApiReference(
      { providerId: 'pokeapi', entityId: 'pikachu-gmax', formId: 'gmax' },
      { fetch },
    )

    expect(result?.metadata.form).toEqual({
      id: '10080',
      name: 'pikachu-gmax',
      isDefault: false,
    })
    expect(result?.provider.formId).toBe('10080')
    expect(result?.asset.variant).toBe('static')
  })

  it('falls back to a static sprite when animation is missing', () => {
    expect(
      extractPokeApiSpriteUrls({ sprites: { front_default: 'https://example.com/static.png' } }),
    ).toEqual({
      animatedUrl: null,
      staticUrl: 'https://example.com/static.png',
      selectedUrl: 'https://example.com/static.png',
      selectedKind: 'static',
    })
  })

  it('returns null for malformed API records instead of inventing provider data', async () => {
    const fetch = mockFetch({ [pokemonUrl]: { name: 'pikachu', sprites: 'broken' } })
    await expect(
      resolvePokeApiReference(
        { providerId: 'pokeapi', entityId: 'pikachu' },
        { fetch },
      ),
    ).resolves.toBeNull()
    expect(extractPokeApiSpriteUrls(null).selectedUrl).toBeNull()
  })

  it('extracts evolution metadata only from a valid PokeAPI chain URL', () => {
    expect(
      extractPokeApiEvolutionChainId({
        evolution_chain: { url: 'https://pokeapi.co/api/v2/evolution-chain/10/' },
      }),
    ).toBe(10)
    expect(
      extractPokeApiEvolutionChainId({
        evolution_chain: { url: 'https://evil.example/evolution-chain/10/' },
      }),
    ).toBeNull()
    expect(extractPokeApiFormIdentity({}, 'gmax')).toEqual({
      id: 'gmax',
      name: 'gmax',
      isDefault: null,
    })
  })

  it('accepts a catalog CompanionForm without coupling the form rules to URLs', async () => {
    const fetch = mockFetch(pikachuRoutes())
    const form = {
      id: 'base',
      name: 'Base',
      kind: 'base',
      provider: { providerId: 'pokeapi', entityId: 'pikachu', formId: 'base' },
      staticAsset: { key: 'pokemon:pikachu:static' },
    } as const

    const result: PokeApiResolution | null = await resolvePokeApiReference(form, { fetch })
    expect(result?.provider.providerId).toBe('pokeapi')
    expect(result?.asset.key).toContain('pokeapi:pokemon:pikachu')
  })
})
