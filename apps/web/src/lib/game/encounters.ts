/**
 * Pure encounter progression and weighted draws.
 *
 * The caller persists the returned state before presenting `newDraws` to the
 * user. Replayed trigger IDs and persisted draw IDs are returned as-is, so a
 * refresh cannot produce a second result for the same milestone.
 */

import {
  CompanionCatalog,
  CompanionDefinition,
  CompanionRarity,
} from './companion-catalog'

export interface EncounterSignals {
  tags?: readonly string[]
  languages?: readonly string[]
  fileTypes?: readonly string[]
}
export interface EncounterWeightBreakdown {
  companionId: string
  baseWeight: number
  tagBonus: number
  languageBonus: number
  fileTypeBonus: number
  matchedTags: readonly string[]
  matchedLanguages: readonly string[]
  matchedFileTypes: readonly string[]
  finalWeight: number
}

export interface PersistedEncounterDraw {
  id: string
  sequence: number
  triggerId: string
  seed: string
  selectedCompanionId: string
  selectedFamilyId: string
  isDuplicate: boolean
  essenceAwarded: number
  /** Frozen evidence used by the draw, useful for transparent history UI. */
  weights: readonly EncounterWeightBreakdown[]
}

export interface EncounterState {
  /** Current hidden meter, always in [0, threshold). */
  meter: number
  totalProgress: number
  nextSequence: number
  draws: readonly PersistedEncounterDraw[]
  processedTriggerIds: readonly string[]
  /** Family ID -> family-specific duplicate Essence. */
  essenceByFamily: Readonly<Record<string, number>>
  /** Local merge aid: progress contributed by each idempotent trigger. */
  readonly progressByTriggerId?: Readonly<Record<string, number>>
}

export interface EncounterConfig {
  threshold: number
  profileKey: string
}

export interface EncounterTrigger {
  id: string
  progress: number
  seed: string
  signals: EncounterSignals
  /** IDs already present in the user's collection before this trigger. */
  ownedCompanionIds: readonly string[]
}

export interface EncounterAdvanceResult {
  state: EncounterState
  newDraws: readonly PersistedEncounterDraw[]
  ignored: boolean
}

export const DEFAULT_ENCOUNTER_CONFIG: EncounterConfig = {
  threshold: 100,
  profileKey: 'guest',
}

export const DEFAULT_RARITY_WEIGHTS: Readonly<Record<CompanionRarity, number>> = {
  common: 100,
  uncommon: 55,
  rare: 20,
  epic: 8,
  legendary: 2,
}

export const DUPLICATE_ESSENCE_BY_RARITY: Readonly<Record<CompanionRarity, number>> = {
  common: 1,
  uncommon: 2,
  rare: 3,
  epic: 5,
  legendary: 8,
}

/** These constants are deliberately public so the UI can explain the draw. */
export const ENCOUNTER_MATCH_BONUSES = {
  perTag: 12,
  perLanguage: 20,
  perFileType: 16,
  maxTagMatches: 3,
} as const

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/^#/, '').replace(/^\./, '')
}

function uniqueNormalized(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(normalizeToken).filter(Boolean))]
}

function intersection(values: readonly string[], preferred: readonly string[]): string[] {
  const preferredSet = new Set(preferred.map(normalizeToken).filter(Boolean))
  return values.filter((value) => preferredSet.has(value))
}

function validateProgress(progress: number): void {
  if (!Number.isFinite(progress) || progress < 0) {
    throw new Error('encounter progress must be a finite non-negative number')
  }
}

function validateConfig(config: EncounterConfig): void {
  if (!Number.isFinite(config.threshold) || config.threshold <= 0) {
    throw new Error('encounter threshold must be positive and finite')
  }
  if (!config.profileKey.trim()) throw new Error('encounter profileKey must not be empty')
}

function validateTrigger(trigger: EncounterTrigger): void {
  if (!trigger.id.trim()) throw new Error('encounter trigger id must not be empty')
  if (!trigger.seed.trim()) throw new Error('encounter seed must not be empty')
  validateProgress(trigger.progress)
}

function weightedBase(definition: CompanionDefinition): number {
  return definition.baseEncounterWeight ?? DEFAULT_RARITY_WEIGHTS[definition.rarity]
}

export function createEncounterState(): EncounterState {
  return {
    meter: 0,
    totalProgress: 0,
    nextSequence: 0,
    draws: [],
    processedTriggerIds: [],
    essenceByFamily: {},
    progressByTriggerId: {},
  }
}

function encounterTriggerHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Stable opaque representation used at the product snapshot boundary. */
export function opaqueEncounterTriggerId(value: string): string {
  const marker = 'trigger-'
  if (value.startsWith(marker) && /^[0-9a-f]{8}-[0-9a-f]{8}$/u.test(value.slice(marker.length))) return value
  let first = 2166136261
  let second = 2246822519
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ (code + index), 3266489917)
  }
  return `trigger-${(first >>> 0).toString(16).padStart(8, '0')}-${(second >>> 0).toString(16).padStart(8, '0')}`
}

function progressTotal(progress: Readonly<Record<string, number>>): number {
  return Object.values(progress).reduce((total, value) => total + value, 0)
}

/**
 * Union local encounter states from two browser writers. A trigger normally
 * produces one draw, but a large progress increment can legitimately produce
 * several draws for the same trigger. Only an identical draw ID is a duplicate;
 * trigger IDs are not a merge key. Sequence collisions are re-keyed while the
 * stable draw ID remains readable enough for local recovery.
 */
export function mergeEncounterStates(left: EncounterState, right: EncounterState): EncounterState {
  const draws = new Map<string, EncounterState['draws'][number]>()
  const sequences = new Set<number>()
  let nextSequence = Math.max(left.nextSequence, right.nextSequence)

  const addDraw = (draw: EncounterState['draws'][number]): void => {
    let id = draw.id
    if (draws.has(id)) {
      const existing = draws.get(id)
      if (existing && JSON.stringify(existing) === JSON.stringify(draw)) return
      id = `${id}:${encounterTriggerHash(`${draw.triggerId}:${draw.sequence}:${draw.seed}`)}`
      while (draws.has(id)) id = `${id}:x`
    }
    let sequence = draw.sequence
    if (sequences.has(sequence)) {
      sequence = nextSequence
      nextSequence += 1
    } else {
      nextSequence = Math.max(nextSequence, sequence + 1)
    }
    const normalized = sequence === draw.sequence && id === draw.id
      ? draw
      : { ...draw, id, sequence }
    draws.set(id, normalized)
    sequences.add(sequence)
  }

  for (const draw of left.draws) addDraw(draw)
  for (const draw of right.draws) addDraw(draw)

  const progressByCanonicalTriggerId = new Map<string, { key: string; progress: number }>()
  for (const [triggerId, progress] of [
    ...Object.entries(left.progressByTriggerId ?? {}),
    ...Object.entries(right.progressByTriggerId ?? {}),
  ]) {
    if (!Number.isFinite(progress) || progress < 0) continue
    const canonicalId = opaqueEncounterTriggerId(triggerId)
    const existing = progressByCanonicalTriggerId.get(canonicalId)
    progressByCanonicalTriggerId.set(canonicalId, {
      key: existing?.key ?? triggerId,
      progress: Math.max(existing?.progress ?? 0, progress),
    })
  }
  const progressByTriggerId: Record<string, number> = Object.fromEntries(
    [...progressByCanonicalTriggerId.values()].map(({ key, progress }) => [key, progress]),
  )
  const hasTriggerProgress = Object.keys(progressByTriggerId).length > 0
  const legacyProgress = hasTriggerProgress
    ? Math.max(0, Math.max(left.totalProgress, right.totalProgress) - progressTotal(progressByTriggerId))
    : Math.max(left.totalProgress, right.totalProgress)
  const totalProgress = hasTriggerProgress
    ? legacyProgress + progressTotal(progressByTriggerId)
    : legacyProgress

  const essenceByFamily: Record<string, number> = {}
  for (const draw of draws.values()) {
    if (draw.essenceAwarded <= 0) continue
    essenceByFamily[draw.selectedFamilyId] =
      (essenceByFamily[draw.selectedFamilyId] ?? 0) + draw.essenceAwarded
  }
  // Preserve aggregate awards from legacy states whose draw list was already
  // compacted, while never allowing a concurrent branch to overwrite a sum
  // recomputed from the union of its distinct draws.
  for (const [familyId, amount] of Object.entries({ ...left.essenceByFamily, ...right.essenceByFamily })) {
    essenceByFamily[familyId] = Math.max(essenceByFamily[familyId] ?? 0, amount)
  }

  return {
    meter: totalProgress % 100,
    totalProgress,
    nextSequence,
    draws: [...draws.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)),
    processedTriggerIds: [...new Set([...left.processedTriggerIds, ...right.processedTriggerIds])],
    essenceByFamily,
    progressByTriggerId,
  }
}

export function getEncounterWeights(
  catalog: CompanionCatalog,
  signals: EncounterSignals,
): readonly EncounterWeightBreakdown[] {
  const tags = uniqueNormalized(signals.tags)
  const languages = uniqueNormalized(signals.languages)
  const fileTypes = uniqueNormalized(signals.fileTypes)

  return [...catalog.list()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((definition) => {
      const matchedTags = intersection(tags, definition.encounterTags).slice(
        0,
        ENCOUNTER_MATCH_BONUSES.maxTagMatches,
      )
      const matchedLanguages = intersection(languages, definition.preferredLanguages)
      const matchedFileTypes = intersection(fileTypes, definition.preferredFileTypes)
      const baseWeight = weightedBase(definition)
      const tagBonus = matchedTags.length * ENCOUNTER_MATCH_BONUSES.perTag
      const languageBonus = matchedLanguages.length > 0 ? ENCOUNTER_MATCH_BONUSES.perLanguage : 0
      const fileTypeBonus = matchedFileTypes.length > 0 ? ENCOUNTER_MATCH_BONUSES.perFileType : 0

      return {
        companionId: definition.id,
        baseWeight,
        tagBonus,
        languageBonus,
        fileTypeBonus,
        matchedTags,
        matchedLanguages,
        matchedFileTypes,
        finalWeight: baseWeight + tagBonus + languageBonus + fileTypeBonus,
      }
    })
}

/** Family-specific value awarded instead of a second collectible copy's XP. */
export function duplicateToFamilyEssence(definition: CompanionDefinition): number {
  return DUPLICATE_ESSENCE_BY_RARITY[definition.rarity]
}

function hashSeed(seed: string): number {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function randomUnit(seed: string): number {
  let value = hashSeed(seed) || 1
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  return (value >>> 0) / 4294967296
}

function chooseWeighted(
  weights: readonly EncounterWeightBreakdown[],
  seed: string,
): EncounterWeightBreakdown {
  if (weights.length === 0) throw new Error('cannot draw from an empty companion catalog')
  const total = weights.reduce((sum, candidate) => sum + candidate.finalWeight, 0)
  if (total <= 0) throw new Error('encounter weights must sum to a positive number')
  let cursor = randomUnit(seed) * total
  for (const candidate of weights) {
    cursor -= candidate.finalWeight
    if (cursor < 0) return candidate
  }
  return weights[weights.length - 1]
}

function drawId(config: EncounterConfig, sequence: number, triggerId: string): string {
  // Sequence numbers are local ordering, not a concurrency lock. Including a
  // stable trigger digest keeps two tabs processing different milestones from
  // producing the same persisted draw ID while retaining the old readable
  // profile/sequence prefix for older data and UI.
  return `${config.profileKey}:${sequence}:${hashSeed(triggerId).toString(16).padStart(8, '0')}`
}

function addEssence(
  essenceByFamily: Readonly<Record<string, number>>,
  familyId: string,
  amount: number,
): Readonly<Record<string, number>> {
  if (amount === 0) return essenceByFamily
  return {
    ...essenceByFamily,
    [familyId]: (essenceByFamily[familyId] ?? 0) + amount,
  }
}

export function advanceEncounter(
  state: EncounterState,
  trigger: EncounterTrigger,
  catalog: CompanionCatalog,
  config: EncounterConfig = DEFAULT_ENCOUNTER_CONFIG,
): EncounterAdvanceResult {
  validateConfig(config)
  validateTrigger(trigger)

  const opaqueTriggerId = opaqueEncounterTriggerId(trigger.id)
  if (state.processedTriggerIds.some((id) => id === trigger.id || id === opaqueTriggerId)) {
    return {
      state,
      newDraws: state.draws.filter((draw) => draw.triggerId === trigger.id),
      ignored: true,
    }
  }

  const meterBefore = state.meter + trigger.progress
  const drawCount = Math.floor(meterBefore / config.threshold)
  let meter = meterBefore - drawCount * config.threshold
  const weights = getEncounterWeights(catalog, trigger.signals)
  const owned = new Set(trigger.ownedCompanionIds)
  const draws = [...state.draws]
  const newDraws: PersistedEncounterDraw[] = []
  let essenceByFamily = state.essenceByFamily

  for (let offset = 0; offset < drawCount; offset += 1) {
    const sequence = state.nextSequence + offset
    const id = drawId(config, sequence, trigger.id)
    const existing = draws.find((draw) => draw.id === id)
    if (existing) {
      newDraws.push(existing)
      owned.add(existing.selectedCompanionId)
      continue
    }

    const selectedWeight = chooseWeighted(weights, `${trigger.seed}:${sequence}`)
    const selected = catalog.get(selectedWeight.companionId)
    if (!selected) throw new Error(`catalog is missing ${selectedWeight.companionId}`)
    const isDuplicate = owned.has(selected.id)
    const essenceAwarded = isDuplicate ? duplicateToFamilyEssence(selected) : 0
    const draw: PersistedEncounterDraw = {
      id,
      sequence,
      triggerId: trigger.id,
      seed: trigger.seed,
      selectedCompanionId: selected.id,
      selectedFamilyId: selected.familyId,
      isDuplicate,
      essenceAwarded,
      weights,
    }
    draws.push(draw)
    newDraws.push(draw)
    owned.add(selected.id)
    essenceByFamily = addEssence(essenceByFamily, selected.familyId, essenceAwarded)
  }

  // Floating point noise must never leave the persisted hidden meter outside its range.
  if (meter >= config.threshold) meter = 0
  const progressByTriggerId = {
    ...(state.progressByTriggerId ?? {}),
    [trigger.id]: trigger.progress,
  }
  const nextState: EncounterState = {
    meter,
    totalProgress: state.totalProgress + trigger.progress,
    nextSequence: state.nextSequence + drawCount,
    draws,
    processedTriggerIds: [...state.processedTriggerIds, trigger.id],
    essenceByFamily,
    progressByTriggerId,
  }
  return { state: nextState, newDraws, ignored: false }
}
