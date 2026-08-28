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

function drawId(config: EncounterConfig, sequence: number): string {
  return `${config.profileKey}:${sequence}`
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

  if (state.processedTriggerIds.includes(trigger.id)) {
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
    const id = drawId(config, sequence)
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
  const nextState: EncounterState = {
    meter,
    totalProgress: state.totalProgress + trigger.progress,
    nextSequence: state.nextSequence + drawCount,
    draws,
    processedTriggerIds: [...state.processedTriggerIds, trigger.id],
    essenceByFamily,
  }
  return { state: nextState, newDraws, ignored: false }
}
