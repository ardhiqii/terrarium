/**
 * Provider-neutral companion definitions.
 *
 * This module deliberately knows nothing about PokeAPI, URLs, or rendering.
 * A provider resolves the opaque asset references at the edge of the app;
 * the game only needs a stable identity, a family, and a valid progression.
 */

import { STAGES } from './types'

export const COMPANION_CATALOG_VERSION = 'companion-catalog:v1'

/** The one progression curve shared by every product companion family. */
export const SHARED_PROGRESSION_THRESHOLDS = {
  sporeling: STAGES[0].threshold,
  mossling: STAGES[1].threshold,
  bracken: STAGES[2].threshold,
  heartwood: STAGES[3].threshold,
} as const

/** Backwards-friendly name for callers that describe this as the companion curve. */
export const COMPANION_PROGRESSION_THRESHOLDS = SHARED_PROGRESSION_THRESHOLDS

export const GRASS_FAMILY_ID = 'grass-family'
export const GRASS_LEGACY_LINE_ID = 'grass'

export type CompanionRarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'

export type ProgressionKind = 'base' | 'evolution' | 'form' | 'mastery'

export interface AssetReference {
  /** Opaque provider-owned key. This is not required to be a URL. */
  key: string
  /** Optional provider-specific variant, such as an idle or front-facing pose. */
  variant?: string
}

export type ProviderValue = string | number | boolean

export interface ProviderMetadata {
  /** Provider namespace, for example `pokeapi` or `artist:studio-name`. */
  providerId: string
  /** Stable provider entity identifier, for example a species or artwork ID. */
  entityId: string
  /** Stable provider form identifier when the entity has forms. */
  formId?: string
  /** Small, serializable metadata bag for adapters and attribution surfaces. */
  metadata?: Readonly<Record<string, ProviderValue>>
}

export interface CompanionForm {
  id: string
  name: string
  kind: ProgressionKind
  provider: ProviderMetadata
  /** A form can expose animation, a static asset, or both. */
  animatedAsset?: AssetReference
  staticAsset?: AssetReference
}

export interface ProgressionStep {
  id: string
  name: string
  /** Cumulative XP required to enter this step. The first step must be zero. */
  threshold: number
  formId: string
  kind: ProgressionKind
  blurb?: string
}

export interface CompanionDefinition {
  /** Stable collectible identity. Two encounters of this ID are duplicates. */
  id: string
  /** Family-specific Essence is tracked under this ID. */
  familyId: string
  name: string
  rarity: CompanionRarity
  /** Explicitly permits this definition's base form to be a new-user starter. */
  starterEligible?: boolean
  /** Legacy line key used by migration adapters, when one exists. */
  legacyLine?: string
  /** Optional override for the rarity's default encounter weight. */
  baseEncounterWeight?: number
  /** Tags used by the rules-based encounter matcher. */
  encounterTags: readonly string[]
  /** Lowercase or mixed-case source values are normalized by the encounter engine. */
  preferredLanguages: readonly string[]
  /** Extensions may be written as `ts` or `.ts`; both are normalized. */
  preferredFileTypes: readonly string[]
  forms: readonly CompanionForm[]
  /** Ordered, explicit path. Evolution and mastery are never inferred. */
  progression: readonly ProgressionStep[]
}

export interface CompanionCatalog {
  readonly entries: readonly CompanionDefinition[]
  /** Version of the rule/content manifest used to resolve this catalog. */
  readonly version?: string
  get(id: string): CompanionDefinition | undefined
  list(): readonly CompanionDefinition[]
}

export type RandomSource = () => number

const PROGRESSION_KINDS: readonly ProgressionKind[] = [
  'base',
  'evolution',
  'form',
  'mastery',
] as const

export interface ResolvedProgression {
  step: ProgressionStep
  form: CompanionForm
  nextStep: ProgressionStep | null
  nextForm: CompanionForm | null
  xpIntoStep: number
  xpForNextStep: number | null
  progress: number
}

const RARITIES: readonly CompanionRarity[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
] as const

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function requireFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`)
  }
}

function requireUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    requireNonEmpty(value, `${label} entry`)
    if (seen.has(value)) throw new Error(`${label} contains duplicate ID "${value}"`)
    seen.add(value)
  }
}

function validateProvider(provider: ProviderMetadata, label: string): void {
  requireNonEmpty(provider.providerId, `${label}.providerId`)
  requireNonEmpty(provider.entityId, `${label}.entityId`)
  if (provider.formId !== undefined) requireNonEmpty(provider.formId, `${label}.formId`)
}

function validateDefinition(definition: CompanionDefinition): void {
  requireNonEmpty(definition.id, 'companion.id')
  requireNonEmpty(definition.familyId, `${definition.id}.familyId`)
  requireNonEmpty(definition.name, `${definition.id}.name`)
  if (!RARITIES.includes(definition.rarity)) {
    throw new Error(`${definition.id}.rarity is not supported`)
  }
  if (definition.starterEligible !== undefined && typeof definition.starterEligible !== 'boolean') {
    throw new Error(`${definition.id}.starterEligible must be boolean`)
  }
  if (definition.legacyLine !== undefined) requireNonEmpty(definition.legacyLine, `${definition.id}.legacyLine`)
  if (
    definition.baseEncounterWeight !== undefined &&
    (!Number.isFinite(definition.baseEncounterWeight) || definition.baseEncounterWeight <= 0)
  ) {
    throw new Error(`${definition.id}.baseEncounterWeight must be positive and finite`)
  }

  requireUnique(definition.forms.map((form) => form.id), `${definition.id}.forms`)
  if (definition.forms.length === 0) throw new Error(`${definition.id} needs at least one form`)

  const formsById = new Map<string, CompanionForm>()
  for (const form of definition.forms) {
    requireNonEmpty(form.id, `${definition.id}.form.id`)
    requireNonEmpty(form.name, `${definition.id}.${form.id}.name`)
    if (!PROGRESSION_KINDS.includes(form.kind)) {
      throw new Error(`${definition.id}.${form.id}.kind is not supported`)
    }
    validateProvider(form.provider, `${definition.id}.${form.id}.provider`)
    if (!form.animatedAsset && !form.staticAsset) {
      throw new Error(`${definition.id}.${form.id} needs an animated or static asset`)
    }
    if (form.animatedAsset) requireNonEmpty(form.animatedAsset.key, `${definition.id}.${form.id}.animatedAsset.key`)
    if (form.staticAsset) requireNonEmpty(form.staticAsset.key, `${definition.id}.${form.id}.staticAsset.key`)
    formsById.set(form.id, form)
  }

  if (definition.progression.length === 0) {
    throw new Error(`${definition.id} needs at least one progression step`)
  }
  requireUnique(definition.progression.map((step) => step.id), `${definition.id}.progression`)
  let previousThreshold = -1
  definition.progression.forEach((step, index) => {
    requireNonEmpty(step.id, `${definition.id}.progression.id`)
    requireNonEmpty(step.name, `${definition.id}.${step.id}.name`)
    requireFiniteNonNegative(step.threshold, `${definition.id}.${step.id}.threshold`)
    if (!PROGRESSION_KINDS.includes(step.kind)) {
      throw new Error(`${definition.id}.${step.id}.kind is not supported`)
    }
    if (index === 0 && step.threshold !== 0) {
      throw new Error(`${definition.id} must start at progression threshold 0`)
    }
    if (step.threshold <= previousThreshold) {
      throw new Error(`${definition.id}.progression thresholds must be strictly increasing`)
    }
    const form = formsById.get(step.formId)
    if (!form) throw new Error(`${definition.id}.${step.id} references missing form "${step.formId}"`)
    if (form.kind !== step.kind) {
      throw new Error(`${definition.id}.${step.id} kind must match form "${step.formId}"`)
    }
    if (index === 0 && step.kind !== 'base') {
      throw new Error(`${definition.id} must start with a base progression step`)
    }
    previousThreshold = step.threshold
  })
}

export function createCompanionCatalog(
  definitions: readonly CompanionDefinition[],
  version = COMPANION_CATALOG_VERSION,
): CompanionCatalog {
  requireNonEmpty(version, 'catalog.version')
  const seen = new Set<string>()
  for (const definition of definitions) {
    validateDefinition(definition)
    if (seen.has(definition.id)) throw new Error(`duplicate companion ID "${definition.id}"`)
    seen.add(definition.id)
  }

  const entries = definitions.map((definition) => ({
    ...definition,
    encounterTags: [...definition.encounterTags],
    preferredLanguages: [...definition.preferredLanguages],
    preferredFileTypes: [...definition.preferredFileTypes],
    forms: definition.forms.map((form) => ({ ...form })),
    progression: definition.progression.map((step) => ({ ...step })),
  }))
  const byId = new Map(entries.map((definition) => [definition.id, definition]))

  return {
    entries,
    version,
    get: (id) => byId.get(id),
    list: () => entries,
  }
}

function isValidStarterDefinition(definition: CompanionDefinition): boolean {
  if (definition.starterEligible !== true) return false
  const firstStep = definition.progression[0]
  if (!firstStep || firstStep.threshold !== 0 || firstStep.kind !== 'base') return false
  const firstForm = definition.forms.find((form) => form.id === firstStep.formId)
  return firstForm?.kind === 'base'
}

/** Returns only explicitly eligible definitions whose first step is a base form. */
export function getStarterCandidates(
  catalog: CompanionCatalog,
): readonly CompanionDefinition[] {
  return catalog.list().filter(isValidStarterDefinition)
}

/** Whether an ID can be assigned as a new profile's base-stage starter. */
export function isStarterEligible(
  catalog: CompanionCatalog,
  companionId: string,
): boolean {
  return getStarterCandidates(catalog).some((definition) => definition.id === companionId)
}

/** Alias for callers that name the result as a list rather than candidates. */
export const listStarterCandidates = getStarterCandidates

/**
 * Selects a starter without coupling the domain to a global random number
 * generator. Callers can inject a seeded source in tests or onboarding.
 */
export function selectStarterCompanion(
  catalog: CompanionCatalog,
  random: RandomSource = Math.random,
): CompanionDefinition {
  const candidates = getStarterCandidates(catalog)
  if (candidates.length === 0) {
    throw new Error('catalog has no eligible base-stage starters')
  }

  const sample = random()
  const normalized = Number.isFinite(sample)
    ? Math.min(1 - Number.EPSILON, Math.max(0, sample))
    : 0
  return candidates[Math.floor(normalized * candidates.length)] ?? candidates[0]
}

export function selectStarterCompanionId(
  catalog: CompanionCatalog,
  random: RandomSource = Math.random,
): string {
  return selectStarterCompanion(catalog, random).id
}

/** Common alternative spellings retained for small callers and tests. */
export const chooseStarterCompanion = selectStarterCompanion
export const selectRandomStarter = selectStarterCompanion
export const pickStarterCompanion = selectStarterCompanion
export const starterCandidates = getStarterCandidates

export function getCompanionForm(
  definition: CompanionDefinition,
  formId: string,
): CompanionForm {
  const form = definition.forms.find((candidate) => candidate.id === formId)
  if (!form) throw new Error(`${definition.id} has no form "${formId}"`)
  return form
}

export function resolveCompanionProgression(
  definition: CompanionDefinition,
  totalXp: number,
): ResolvedProgression {
  const xp = Number.isFinite(totalXp) ? Math.max(0, totalXp) : 0
  let index = 0
  for (let i = 0; i < definition.progression.length; i += 1) {
    if (xp >= definition.progression[i].threshold) index = i
    else break
  }

  const step = definition.progression[index]
  const nextStep = definition.progression[index + 1] ?? null
  const form = getCompanionForm(definition, step.formId)
  const nextForm = nextStep ? getCompanionForm(definition, nextStep.formId) : null
  if (!nextStep) {
    return {
      step,
      form,
      nextStep: null,
      nextForm: null,
      xpIntoStep: xp - step.threshold,
      xpForNextStep: null,
      progress: 1,
    }
  }

  const xpForNextStep = nextStep.threshold - step.threshold
  return {
    step,
    form,
    nextStep,
    nextForm,
    xpIntoStep: xp - step.threshold,
    xpForNextStep,
    progress: Math.min(1, Math.max(0, (xp - step.threshold) / xpForNextStep)),
  }
}

/**
 * Prototype definitions used by local playtests. The game still stores only
 * opaque provider references; `pokemon-provider.ts` resolves these references
 * to live PokeAPI metadata and chooses animation or static fallback at the
 * rendering boundary. Pokémon content remains prototype-only and is not a
 * commercial marketplace asset.
 */
export const PROTOTYPE_COMPANION_CATALOG = createCompanionCatalog([
  {
    id: 'pikachu-family',
    familyId: 'pikachu-family',
    name: 'Pikachu family',
    rarity: 'common',
    starterEligible: true,
    encounterTags: ['energy', 'social', 'momentum'],
    preferredLanguages: ['typescript', 'javascript'],
    preferredFileTypes: ['ts', 'tsx', 'js', 'jsx'],
    forms: [
      {
        id: 'base',
        name: 'Pikachu',
        kind: 'base',
        provider: {
          providerId: 'pokeapi',
          entityId: 'pikachu',
          formId: '25',
          metadata: { evolutionChainId: 10 },
        },
        animatedAsset: { key: 'pokeapi:pokemon:pikachu:25', variant: 'animated' },
        staticAsset: { key: 'pokeapi:pokemon:pikachu:25', variant: 'static' },
      },
      {
        id: 'evolved',
        name: 'Raichu',
        kind: 'evolution',
        provider: {
          providerId: 'pokeapi',
          entityId: 'raichu',
          formId: '26',
          metadata: { evolutionChainId: 10 },
        },
        animatedAsset: { key: 'pokeapi:pokemon:raichu:26', variant: 'animated' },
        staticAsset: { key: 'pokeapi:pokemon:raichu:26', variant: 'static' },
      },
    ],
    progression: [
      { id: 'base', name: 'Beginning', threshold: 0, formId: 'base', kind: 'base' },
      {
        id: 'evolved',
        name: 'Charged',
        threshold: SHARED_PROGRESSION_THRESHOLDS.mossling,
        formId: 'evolved',
        kind: 'evolution',
      },
    ],
  },
  {
    id: 'ditto-like',
    familyId: 'ditto-family',
    name: 'Ditto-like',
    rarity: 'uncommon',
    starterEligible: true,
    encounterTags: ['adaptation', 'refactor', 'testing'],
    preferredLanguages: ['python', 'ruby'],
    preferredFileTypes: ['py', 'rb', 'md'],
    forms: [
      {
        id: 'base',
        name: 'Ditto',
        kind: 'base',
        provider: { providerId: 'pokeapi', entityId: 'ditto', formId: '132' },
        staticAsset: { key: 'pokeapi:pokemon:ditto:132', variant: 'static' },
      },
    ],
    progression: [
      { id: 'base', name: 'Beginning', threshold: 0, formId: 'base', kind: 'base' },
    ],
  },
  {
    id: GRASS_FAMILY_ID,
    familyId: GRASS_FAMILY_ID,
    name: 'Mossling family',
    rarity: 'common',
    starterEligible: true,
    legacyLine: GRASS_LEGACY_LINE_ID,
    encounterTags: ['garden', 'growth', 'green'],
    preferredLanguages: ['typescript', 'javascript', 'markdown'],
    preferredFileTypes: ['md', 'mdx', 'ts', 'tsx', 'js', 'jsx'],
    forms: [
      {
        id: 'sporeling',
        name: 'Sporeling',
        kind: 'base',
        provider: {
          providerId: 'pokeapi',
          entityId: 'bulbasaur',
          formId: '1',
          metadata: { evolutionChainId: 1 },
        },
        animatedAsset: { key: 'pokeapi:pokemon:bulbasaur:1', variant: 'animated' },
        staticAsset: { key: 'pokeapi:pokemon:bulbasaur:1', variant: 'static' },
      },
      {
        id: 'mossling',
        name: 'Mossling',
        kind: 'evolution',
        provider: {
          providerId: 'pokeapi',
          entityId: 'ivysaur',
          formId: '2',
          metadata: { evolutionChainId: 1 },
        },
        animatedAsset: { key: 'pokeapi:pokemon:ivysaur:2', variant: 'animated' },
        staticAsset: { key: 'pokeapi:pokemon:ivysaur:2', variant: 'static' },
      },
      {
        id: 'bracken',
        name: 'Bracken',
        kind: 'evolution',
        provider: {
          providerId: 'pokeapi',
          entityId: 'venusaur',
          formId: '3',
          metadata: { evolutionChainId: 1 },
        },
        animatedAsset: { key: 'pokeapi:pokemon:venusaur:3', variant: 'animated' },
        staticAsset: { key: 'pokeapi:pokemon:venusaur:3', variant: 'static' },
      },
      {
        id: 'heartwood',
        name: 'Heartwood',
        kind: 'mastery',
        provider: {
          providerId: 'pokeapi',
          entityId: 'venusaur-mega',
          formId: '10033',
          metadata: { evolutionChainId: 1, isDefaultForm: false },
        },
        staticAsset: { key: 'pokeapi:pokemon:venusaur-mega:10033', variant: 'static' },
      },
    ],
    progression: [
      {
        id: 'sporeling',
        name: 'Beginning',
        threshold: SHARED_PROGRESSION_THRESHOLDS.sporeling,
        formId: 'sporeling',
        kind: 'base',
      },
      {
        id: 'mossling',
        name: 'Growing',
        threshold: SHARED_PROGRESSION_THRESHOLDS.mossling,
        formId: 'mossling',
        kind: 'evolution',
      },
      {
        id: 'bracken',
        name: 'Rooted',
        threshold: SHARED_PROGRESSION_THRESHOLDS.bracken,
        formId: 'bracken',
        kind: 'evolution',
      },
      {
        id: 'heartwood',
        name: 'Mastery',
        threshold: SHARED_PROGRESSION_THRESHOLDS.heartwood,
        formId: 'heartwood',
        kind: 'mastery',
      },
    ],
  },
] as const)

/** Canonical Grass/Mossling definition exposed for migration and asset tests. */
export const GRASS_COMPANION_DEFINITION = PROTOTYPE_COMPANION_CATALOG.get(GRASS_FAMILY_ID)!
export const GRASS_FAMILY_COMPANION = GRASS_COMPANION_DEFINITION
