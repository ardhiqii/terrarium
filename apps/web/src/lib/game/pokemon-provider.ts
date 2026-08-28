import type {
  AssetReference,
  CompanionForm,
  ProviderMetadata,
} from './companion-catalog'

/** The provider name used by opaque catalog references. */
export const POKEAPI_PROVIDER_ID = 'pokeapi'
export const POKEAPI_API_BASE_URL = 'https://pokeapi.co/api/v2'

export type PokeApiReference = ProviderMetadata | CompanionForm

export interface PokeApiSpriteUrls {
  animatedUrl: string | null
  staticUrl: string | null
  selectedUrl: string | null
  selectedKind: 'animated' | 'static' | null
}

export interface PokeApiFormIdentity {
  id: string | null
  name: string | null
  isDefault: boolean | null
}

export interface PokeApiMetadata {
  pokemonName: string
  pokemonId: number | null
  speciesName: string | null
  form: PokeApiFormIdentity
  evolutionChainId: number | null
}

export interface PokeApiResolution {
  /** The original opaque reference; no URL is required by the game. */
  provider: ProviderMetadata
  /** A stable opaque asset key plus the selected representation. */
  asset: AssetReference
  sprites: PokeApiSpriteUrls
  metadata: PokeApiMetadata
  evolutionChainId: number | null
}

export interface ResolvePokeApiOptions {
  /** Injectable at the server boundary and useful for deterministic tests. */
  fetch?: typeof fetch
}

interface RecordObject {
  readonly [key: string]: unknown
}

function isRecord(value: unknown): value is RecordObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${label} must be a non-empty string`)
  return normalized
}

function pathSegment(value: string | number, label: string): string {
  const normalized = nonEmpty(String(value), label)
  return encodeURIComponent(normalized)
}

/** Builds a PokeAPI URL without fetching or importing any server-only APIs. */
export function buildPokeApiPokemonUrl(entityId: string | number): string {
  return `${POKEAPI_API_BASE_URL}/pokemon/${pathSegment(entityId, 'entityId')}`
}

/** Builds the species URL used to obtain the evolution-chain reference. */
export function buildPokeApiSpeciesUrl(speciesId: string | number): string {
  return `${POKEAPI_API_BASE_URL}/pokemon-species/${pathSegment(speciesId, 'speciesId')}`
}

/** Builds an evolution-chain URL from its numeric PokeAPI identifier. */
export function buildPokeApiEvolutionChainUrl(chainId: string | number): string {
  return `${POKEAPI_API_BASE_URL}/evolution-chain/${pathSegment(chainId, 'chainId')}`
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function nullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function urlValue(value: unknown): string | null {
  const candidate = stringValue(value)
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function nestedRecord(value: unknown, ...keys: string[]): RecordObject | null {
  let current: unknown = value
  for (const key of keys) {
    if (!isRecord(current)) return null
    current = current[key]
  }
  return isRecord(current) ? current : null
}

function firstUrl(record: RecordObject | null, keys: readonly string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const candidate = urlValue(record[key])
    if (candidate) return candidate
  }
  return null
}

/**
 * Extracts renderable sprite URLs from an untrusted PokeAPI Pokémon record.
 * The selected URL always prefers animation and falls back to a static sprite.
 */
export function extractPokeApiSpriteUrls(record: unknown): PokeApiSpriteUrls {
  if (!isRecord(record)) {
    return {
      animatedUrl: null,
      staticUrl: null,
      selectedUrl: null,
      selectedKind: null,
    }
  }

  const sprites = isRecord(record.sprites) ? record.sprites : null
  const animated = nestedRecord(
    sprites?.versions,
    'generation-v',
    'black-white',
    'animated',
  )
  const animatedUrl = firstUrl(animated, ['front_default'])

  const staticUrl =
    firstUrl(sprites, ['front_default']) ??
    firstUrl(nestedRecord(sprites?.versions, 'generation-v', 'black-white'), [
      'front_default',
    ]) ??
    firstUrl(nestedRecord(sprites?.other, 'official-artwork'), ['front_default']) ??
    firstUrl(nestedRecord(sprites?.other, 'home'), ['front_default'])

  if (animatedUrl) {
    return {
      animatedUrl,
      staticUrl,
      selectedUrl: animatedUrl,
      selectedKind: 'animated',
    }
  }
  return {
    animatedUrl: null,
    staticUrl,
    selectedUrl: staticUrl,
    selectedKind: staticUrl ? 'static' : null,
  }
}

function formNameFromRecord(record: RecordObject): string | null {
  if (!Array.isArray(record.forms)) return null
  const form = record.forms.find((candidate) => isRecord(candidate))
  return form && isRecord(form) ? stringValue(form.name) : null
}

function formIdFromRecord(record: RecordObject, formName: string | null): string | null {
  if (!Array.isArray(record.forms)) return formName
  const form = record.forms.find((candidate) => isRecord(candidate))
  if (!isRecord(form)) return formName
  const url = stringValue(form.url)
  if (url) {
    const match = url.match(/\/(\d+)\/?$/)
    if (match) return match[1]
  }
  return formName
}

/** Extracts the stable form identity exposed by the Pokémon endpoint. */
export function extractPokeApiFormIdentity(
  record: unknown,
  fallbackFormId?: string,
): PokeApiFormIdentity {
  if (!isRecord(record)) {
    return {
      id: fallbackFormId ?? null,
      name: fallbackFormId ?? null,
      isDefault: null,
    }
  }
  const name = formNameFromRecord(record)
  return {
    id: formIdFromRecord(record, name) ?? fallbackFormId ?? null,
    name: name ?? fallbackFormId ?? null,
    isDefault: nullableBoolean(record.is_default),
  }
}

function idFromUrl(value: unknown, resource: string): number | null {
  const candidate = stringValue(value)
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    if (url.origin !== new URL(POKEAPI_API_BASE_URL).origin) return null
    const pattern = new RegExp(`/api/v2/${resource}/(\\d+)/?$`)
    const match = url.pathname.match(pattern)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

function isPokeApiResourceUrl(value: string, resource: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.origin === new URL(POKEAPI_API_BASE_URL).origin &&
      new RegExp(`/api/v2/${resource}/[^/]+/?$`).test(url.pathname)
    )
  } catch {
    return false
  }
}

/** Extracts the evolution-chain ID from a species record without a network call. */
export function extractPokeApiEvolutionChainId(record: unknown): number | null {
  if (!isRecord(record) || !isRecord(record.evolution_chain)) return null
  return idFromUrl(record.evolution_chain.url, 'evolution-chain')
}

/** Extracts provider metadata from already-fetched Pokémon and species records. */
export function extractPokeApiMetadata(
  pokemonRecord: unknown,
  speciesRecord: unknown,
  fallbackFormId?: string,
): PokeApiMetadata | null {
  if (!isRecord(pokemonRecord)) return null
  const pokemonName = stringValue(pokemonRecord.name)
  if (!pokemonName) return null
  const species = isRecord(pokemonRecord.species) ? pokemonRecord.species : null
  return {
    pokemonName,
    pokemonId: nullableInteger(pokemonRecord.id),
    speciesName: stringValue(species?.name),
    form: extractPokeApiFormIdentity(pokemonRecord, fallbackFormId),
    evolutionChainId: extractPokeApiEvolutionChainId(speciesRecord),
  }
}

function providerMetadataFromReference(reference: PokeApiReference): ProviderMetadata {
  const provider = 'provider' in reference ? reference.provider : reference
  if (provider.providerId !== POKEAPI_PROVIDER_ID) {
    throw new TypeError(`providerId must be ${POKEAPI_PROVIDER_ID}`)
  }
  nonEmpty(provider.entityId, 'entityId')
  if (provider.formId !== undefined) nonEmpty(provider.formId, 'formId')
  return { ...provider }
}

function opaqueAssetKey(provider: ProviderMetadata, form: PokeApiFormIdentity): string {
  return `${provider.providerId}:pokemon:${provider.entityId}:${form.id ?? 'default'}`
}

async function fetchJson(
  client: typeof fetch,
  url: string,
): Promise<unknown | null> {
  try {
    const response = await client(url, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Server-side resolver for an opaque catalog reference. It only fetches the
 * provider API, returns provider data at the boundary, and never exposes URLs
 * to companion rules. Import this from server code; use the pure helpers in
 * client code.
 */
export async function resolvePokeApiReference(
  reference: PokeApiReference,
  options: ResolvePokeApiOptions = {},
): Promise<PokeApiResolution | null> {
  let provider: ProviderMetadata
  try {
    provider = providerMetadataFromReference(reference)
  } catch {
    return null
  }

  const client = options.fetch ?? globalThis.fetch
  if (typeof client !== 'function') return null

  const pokemonRecord = await fetchJson(client, buildPokeApiPokemonUrl(provider.entityId))
  if (!isRecord(pokemonRecord)) return null

  const species = isRecord(pokemonRecord.species) ? pokemonRecord.species : null
  const speciesUrl = stringValue(species?.url)
  const speciesRecord =
    speciesUrl && isPokeApiResourceUrl(speciesUrl, 'pokemon-species')
      ? await fetchJson(client, speciesUrl)
      : null
  const metadata = extractPokeApiMetadata(pokemonRecord, speciesRecord, provider.formId)
  if (!metadata) return null

  const sprites = extractPokeApiSpriteUrls(pokemonRecord)
  if (!sprites.selectedUrl || !sprites.selectedKind) return null

  const resolvedProvider: ProviderMetadata = {
    ...provider,
    ...(metadata.form.id ? { formId: metadata.form.id } : {}),
    metadata: {
      ...provider.metadata,
      pokemonName: metadata.pokemonName,
      ...(metadata.pokemonId === null ? {} : { pokemonId: metadata.pokemonId }),
      ...(metadata.speciesName ? { speciesName: metadata.speciesName } : {}),
      ...(metadata.form.name ? { formName: metadata.form.name } : {}),
      ...(metadata.form.isDefault === null
        ? {}
        : { isDefaultForm: metadata.form.isDefault }),
      ...(metadata.evolutionChainId === null
        ? {}
        : { evolutionChainId: metadata.evolutionChainId }),
    },
  }

  return {
    provider: resolvedProvider,
    asset: {
      key: opaqueAssetKey(provider, metadata.form),
      variant: sprites.selectedKind,
    },
    sprites,
    metadata,
    evolutionChainId: metadata.evolutionChainId,
  }
}

/** Descriptive alias for callers that name the operation as an asset lookup. */
export const resolvePokeApiAsset = resolvePokeApiReference
