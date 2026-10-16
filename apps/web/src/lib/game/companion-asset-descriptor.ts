import type {
  CompanionDefinition,
  CompanionForm,
  ProgressionKind,
  ProviderMetadata,
} from './companion-catalog'
import { getSprite } from './sprites'
import { STAGES, type SpriteData, type StageId } from './types'

/**
 * The identity a provider response/cache entry must satisfy before it can be
 * used for a companion.  The catalog remains the authority; URLs and cached
 * metadata are only renderable evidence when they match this identity.
 */
export interface CompanionAssetIdentity {
  providerId: string
  entityId: string
  formId: string | null
  expectedPokemonId: number | null
}

export interface CompanionRemoteAsset {
  /** Animated URL, when the provider has a safe animated representation. */
  animatedUrl: string | null
  /** Still URL used for reduced motion and animation fallback. */
  staticUrl: string | null
  width: number
  height: number
  source: 'cache' | 'provider' | 'derived'
}

/**
 * Serializable asset input for `CompanionSprite` and the page/runtime
 * boundaries. It intentionally contains no resolver functions, fetch clients,
 * filesystem handles, or server-only values.
 */
export interface CompanionAssetDescriptor {
  companionId: string
  familyId: string
  formId: string
  formName: string
  kind: ProgressionKind
  /** Frozen by the catalog: do not invent animation for static-only forms. */
  allowsAnimation: boolean
  /** Default accessible label. Callers may provide a more contextual alt. */
  alt: string
  provider: ProviderMetadata
  identity: CompanionAssetIdentity
  /** The guaranteed local code-generated fallback. */
  local: SpriteData
  /** Null means the renderer must use `local`. */
  remote: CompanionRemoteAsset | null
}

const FALLBACK_SPRITE: SpriteData = {
  id: 'companion-fallback',
  width: 1,
  height: 1,
  palette: ['transparent'],
  frames: [['0']],
}

function cloneSprite(sprite: SpriteData): SpriteData {
  return {
    ...sprite,
    palette: [...sprite.palette],
    frames: sprite.frames.map((frame) => [...frame]),
  }
}

function numericId(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const normalized = String(value).trim()
  if (!/^\d+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function providerIdentity(provider: ProviderMetadata): CompanionAssetIdentity {
  const metadataPokemonId = provider.metadata?.pokemonId
  return {
    providerId: provider.providerId,
    entityId: provider.entityId,
    formId: provider.formId ?? null,
    expectedPokemonId:
      numericId(provider.formId) ?? numericId(metadataPokemonId) ?? numericId(provider.entityId),
  }
}

function fallbackStageForForm(
  definition: CompanionDefinition,
  form: CompanionForm,
): StageId {
  const progressionIndex = definition.progression.findIndex((step) => step.formId === form.id)
  if (progressionIndex >= 0) {
    return STAGES[Math.min(progressionIndex, STAGES.length - 1)].id
  }

  // A form not yet represented in the explicit path still gets a stable,
  // harmless local silhouette rather than an empty image.
  if (form.kind === 'mastery') return 'heartwood'
  if (form.kind === 'evolution' || form.kind === 'form') return 'mossling'
  return 'sporeling'
}

function localFallback(definition: CompanionDefinition, form: CompanionForm): SpriteData {
  const stage = fallbackStageForForm(definition, form)
  return cloneSprite(getSprite(stage) ?? getSprite('sporeling') ?? FALLBACK_SPRITE)
}

function copyProvider(provider: ProviderMetadata): ProviderMetadata {
  return {
    ...provider,
    ...(provider.metadata ? { metadata: { ...provider.metadata } } : {}),
  }
}

/**
 * Build the provider-neutral, serializable companion asset descriptor. This
 * function does not fetch and does not import any server-only module.
 */
export function createCompanionAssetDescriptor(
  definition: CompanionDefinition,
  form: CompanionForm,
  alt?: string,
): CompanionAssetDescriptor {
  if (!definition.forms.some((candidate) => candidate.id === form.id)) {
    throw new Error(`${definition.id} does not contain form "${form.id}"`)
  }

  const label = alt?.trim() || form.name
  return {
    companionId: definition.id,
    familyId: definition.familyId,
    formId: form.id,
    formName: form.name,
    kind: form.kind,
    allowsAnimation: Boolean(form.animatedAsset),
    alt: label,
    provider: copyProvider(form.provider),
    identity: providerIdentity(form.provider),
    local: localFallback(definition, form),
    remote: null,
  }
}

/** Resolve a form by id and create its asset descriptor. */
export function describeCompanionAsset(
  definition: CompanionDefinition,
  formId: string,
  alt?: string,
): CompanionAssetDescriptor {
  const form = definition.forms.find((candidate) => candidate.id === formId)
  if (!form) throw new Error(`${definition.id} has no form "${formId}"`)
  return createCompanionAssetDescriptor(definition, form, alt)
}

/** Attach a resolved remote representation without mutating the base descriptor. */
export function withCompanionRemoteAsset(
  descriptor: CompanionAssetDescriptor,
  remote: CompanionRemoteAsset | null,
): CompanionAssetDescriptor {
  return { ...descriptor, remote }
}

/**
 * A defensive helper for callers restoring a serialized descriptor. It keeps
 * the component boundary fail-closed when an untrusted value is malformed.
 */
export function hasRenderableLocalSprite(
  descriptor: CompanionAssetDescriptor,
): boolean {
  const local = descriptor?.local
  if (!local) return false
  return (
    Number.isInteger(local.width) &&
    local.width > 0 &&
    Number.isInteger(local.height) &&
    local.height > 0 &&
    Array.isArray(local.palette) &&
    local.palette.length > 0 &&
    Array.isArray(local.frames) &&
    local.frames.length > 0
  )
}
