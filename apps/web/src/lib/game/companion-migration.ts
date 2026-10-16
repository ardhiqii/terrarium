/**
 * Pure migration from the legacy CreatureState aggregate into the product
 * companion model.
 *
 * Legacy garden/GitHub counters do not have stable event IDs. They therefore
 * become one versioned credit, never synthetic NormalizedEvent records. The
 * function returns a new immutable ProductState; persistence layers can write
 * that result transactionally and retain the input as their recovery copy.
 */

import {
  GRASS_FAMILY_ID,
  type CompanionCatalog,
  type CompanionDefinition,
} from './companion-catalog'
import {
  getActiveCompanionSelection,
  hasUntouchedStarterSelection,
  LEGACY_CREATURE_MIGRATION_VERSION,
  type GuestProfile,
  type LegacyXpCredit,
} from './guest-profile'
import { createProductState, type ProductState } from './product-state'
import { computeCommitXp, computeGardenXp } from './xp'
import type { GardenStats, GithubStats } from './types'

export interface LegacyCreatureInput {
  readonly legacyStats: GardenStats
  readonly legacyGithub?: GithubStats | null
  /** Caller-supplied stable source fingerprint, when one already exists. */
  readonly sourceFingerprint?: string
  /** Optional adapter override for a future legacy line. */
  readonly legacyCompanionId?: string
  readonly legacyLine?: string
}

export interface LegacyMigrationOptions {
  readonly now: string
  readonly migrationVersion?: string
}

export interface LegacyCreatureXpBreakdown {
  readonly gardenXp: number
  readonly commitXp: number
  readonly totalXp: number
}

export type LegacyMigrationStatus = 'applied' | 'already-applied' | 'conflict'

export interface LegacyMigrationResult {
  readonly state: ProductState
  readonly changed: boolean
  readonly status: LegacyMigrationStatus
  readonly credit: LegacyXpCredit
  readonly gardenXp: number
  readonly commitXp: number
  readonly totalXp: number
  readonly migrationVersion: string
  /** Present only when a persisted credit conflicts with the requested input. */
  readonly conflictCredit?: LegacyXpCredit
}

export type CompanionMigrationResult = LegacyMigrationResult

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
}

function assertCount(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new TypeError(`${field} must be a finite non-negative integer`)
  }
}

function assertDateOrNull(value: unknown, field: string): void {
  if (value === null) return
  assertNonEmpty(value, field)
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be a timestamp or null`)
}

function assertGardenStats(value: GardenStats): void {
  if (!value || typeof value !== 'object') throw new TypeError('legacyStats must be an object')
  const candidate = value as unknown as Record<string, unknown>
  for (const field of [
    'noteCount',
    'projectCount',
    'totalWords',
    'resolvedWikilinks',
    'backlinksReceived',
    'tagCount',
    'maxBacklinksOnSingleNote',
  ]) {
    assertCount(candidate[field], `legacyStats.${field}`)
  }
  if (!candidate.maturityCounts || typeof candidate.maturityCounts !== 'object') {
    throw new TypeError('legacyStats.maturityCounts must be an object')
  }
  const maturityCounts = candidate.maturityCounts as Record<string, unknown>
  for (const field of ['seedling', 'budding', 'evergreen']) {
    assertCount(maturityCounts[field], `legacyStats.maturityCounts.${field}`)
  }
  assertDateOrNull(candidate.firstPublishedAt, 'legacyStats.firstPublishedAt')
  assertDateOrNull(candidate.lastPublishedAt, 'legacyStats.lastPublishedAt')
}

function assertNumberMap(value: unknown, field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertNonEmpty(key, `${field} key`)
    assertCount(item, `${field}.${key}`)
  }
}

function assertGithubStats(value: GithubStats | null | undefined): void {
  if (value === null || value === undefined) return
  if (!value || typeof value !== 'object') throw new TypeError('legacyGithub must be an object or null')
  const candidate = value as unknown as Record<string, unknown>
  assertNonEmpty(candidate.login, 'legacyGithub.login')
  assertCount(candidate.totalCommits, 'legacyGithub.totalCommits')
  assertCount(candidate.currentStreakDays, 'legacyGithub.currentStreakDays')
  assertNonEmpty(candidate.fetchedAt, 'legacyGithub.fetchedAt')
  if (Number.isNaN(Date.parse(candidate.fetchedAt))) throw new TypeError('legacyGithub.fetchedAt must be a timestamp')
  assertNumberMap(candidate.commitsByDay, 'legacyGithub.commitsByDay')
  assertNumberMap(candidate.gardenCommitsByDay, 'legacyGithub.gardenCommitsByDay')

  const commitsByDay = candidate.commitsByDay as Record<string, number>
  for (const [day, gardenCount] of Object.entries(candidate.gardenCommitsByDay as Record<string, number>)) {
    if (gardenCount > (commitsByDay[day] ?? 0)) {
      throw new TypeError(`legacyGithub.gardenCommitsByDay.${day} exceeds commitsByDay`)
    }
  }
}

/** Validate and recompute the legacy arithmetic. Rendered totals are ignored. */
export function computeLegacyCreatureXp(
  input: LegacyCreatureInput,
): LegacyCreatureXpBreakdown {
  assertGardenStats(input.legacyStats)
  assertGithubStats(input.legacyGithub)
  const gardenXp = computeGardenXp(input.legacyStats).reduce((sum, entry) => sum + entry.xp, 0)
  const commitXp = computeCommitXp(input.legacyGithub ?? null).reduce((sum, entry) => sum + entry.xp, 0)
  const totalXp = gardenXp + commitXp
  if (![gardenXp, commitXp, totalXp].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new TypeError('legacy XP arithmetic must be finite and non-negative')
  }
  return { gardenXp, commitXp, totalXp }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`
}

function hashFingerprint(value: string): string {
  let first = 2166136261
  let second = 2246822519
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ (code + index), 3266489917)
  }
  return `legacy:${(first >>> 0).toString(16).padStart(8, '0')}-${(second >>> 0).toString(16).padStart(8, '0')}`
}

/** Stable across object-key ordering and repeated migration attempts. */
export function fingerprintLegacyCreatureInput(input: LegacyCreatureInput): string {
  assertGardenStats(input.legacyStats)
  assertGithubStats(input.legacyGithub)
  return hashFingerprint(stableSerialize({
    legacyStats: input.legacyStats,
    legacyGithub: input.legacyGithub ?? null,
  }))
}

function legacyDefinition(
  catalog: CompanionCatalog,
  input: LegacyCreatureInput,
): CompanionDefinition {
  const requestedId = input.legacyCompanionId ?? GRASS_FAMILY_ID
  const byId = catalog.get(requestedId)
  const byLine = input.legacyLine
    ? catalog.list().find((definition) => definition.legacyLine === input.legacyLine)
    : undefined
  const definition = byLine ?? byId
  if (!definition) throw new Error(`catalog is missing legacy companion ${requestedId}`)
  return definition
}

function sameCredit(left: LegacyXpCredit, right: LegacyXpCredit): boolean {
  return left.creditId === right.creditId &&
    left.migrationVersion === right.migrationVersion &&
    left.companionId === right.companionId &&
    left.totalXp === right.totalXp &&
    left.sourceFingerprint === right.sourceFingerprint
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Apply the legacy aggregate exactly once. This is deliberately pure: a
 * storage boundary can retain `state` as a recovery copy and only replace it
 * with `result.state` after its atomic write succeeds.
 */
export function migrateLegacyCreature(
  state: ProductState,
  input: LegacyCreatureInput,
  catalog: CompanionCatalog,
  options: LegacyMigrationOptions,
): LegacyMigrationResult {
  assertNonEmpty(options.now, 'migration now')
  const migrationVersion = options.migrationVersion ?? LEGACY_CREATURE_MIGRATION_VERSION
  assertNonEmpty(migrationVersion, 'migrationVersion')
  const arithmetic = computeLegacyCreatureXp(input)
  const definition = legacyDefinition(catalog, input)
  const sourceFingerprint = input.sourceFingerprint?.trim() || fingerprintLegacyCreatureInput(input)
  const requestedCredit: LegacyXpCredit = {
    creditId: `migration:${migrationVersion}:${definition.id}`,
    migrationVersion,
    companionId: definition.id,
    totalXp: arithmetic.totalXp,
    sourceFingerprint,
  }

  const persistedCredits = state.profile.legacyCredits ?? []
  const existingCredit = persistedCredits.find((credit) => credit.creditId === requestedCredit.creditId)
  if (existingCredit && !sameCredit(existingCredit, requestedCredit)) {
    return {
      state,
      changed: false,
      status: 'conflict',
      credit: existingCredit,
      conflictCredit: existingCredit,
      ...arithmetic,
      migrationVersion,
    }
  }

  const migrationReferenceId = `migration:${migrationVersion}:${definition.id}`
  const existingMigrationReference = state.profile.collection.find(
    (reference) => reference.referenceId === migrationReferenceId,
  )
  if (existingMigrationReference && (
    existingMigrationReference.companionId !== definition.id ||
    existingMigrationReference.acquisition !== 'history'
  )) {
    return {
      state,
      changed: false,
      status: 'conflict',
      credit: existingCredit ?? requestedCredit,
      ...arithmetic,
      migrationVersion,
    }
  }
  const hasMigrationReference = existingMigrationReference !== undefined
  // Once the marker, credit, reference, and active-selection provenance are
  // all durable, a retry is a true no-op even when its wall-clock `now` differs.
  if (
    existingCredit &&
    state.profile.migrationVersion === migrationVersion &&
    hasMigrationReference &&
    state.profile.activeSelection?.companionId === state.profile.activeCompanionId &&
    state.profile.activeSelection?.provenance !== 'starter'
  ) {
    return {
      state,
      changed: false,
      status: 'already-applied',
      credit: requestedCredit,
      ...arithmetic,
      migrationVersion,
    }
  }

  const nextCollection = hasMigrationReference
    ? state.profile.collection
    : [
        ...state.profile.collection,
        {
          referenceId: migrationReferenceId,
          companionId: definition.id,
          acquiredAt: options.now,
          acquisition: 'history' as const,
        },
      ]
  const nextCredits = existingCredit
    ? persistedCredits
    : [...persistedCredits, requestedCredit]

  const inferredSelection = getActiveCompanionSelection(state.profile)
  const hasOnlyUntouchedStarter = !state.profile.activeSelection &&
    state.profile.collection.length === 1 &&
    state.profile.collection[0]?.acquisition === 'starter' &&
    state.profile.collection[0]?.companionId === state.profile.activeCompanionId
  // Old product snapshots did not persist selection provenance. Only a profile
  // with no explicit selection and its original starter can use this structural
  // fallback; an explicit `user` selection, even if it points at that starter,
  // must not be overwritten by migration.
  const shouldActivateLegacyCompanion = hasUntouchedStarterSelection(state.profile) ||
    hasOnlyUntouchedStarter ||
    inferredSelection.provenance === 'starter'
  let activeCompanionId = state.profile.activeCompanionId
  let activeSelection = state.profile.activeSelection
  if (!activeSelection || activeSelection.companionId !== activeCompanionId) {
    activeSelection = inferredSelection
  }
  if (shouldActivateLegacyCompanion) {
    activeCompanionId = definition.id
    activeSelection = {
      companionId: definition.id,
      provenance: 'migration',
      selectedAt: options.now,
      migrationVersion,
    }
  }

  const nextProfile: GuestProfile = {
    ...state.profile,
    updatedAt: options.now,
    activeCompanionId,
    ...(activeSelection ? { activeSelection } : {}),
    catalogVersion: state.profile.catalogVersion ?? catalog.version,
    migrationVersion,
    legacyCredits: nextCredits,
    collection: nextCollection,
  }
  const changed = !sameJson(nextProfile, state.profile)
  if (!changed) {
    return {
      state,
      changed: false,
      status: 'already-applied',
      credit: requestedCredit,
      ...arithmetic,
      migrationVersion,
    }
  }

  return {
    state: createProductState(nextProfile, state.ledger, state.encounters, catalog),
    changed: true,
    status: 'applied',
    credit: requestedCredit,
    ...arithmetic,
    migrationVersion,
  }
}

/** Common aliases used by callers that describe the operation as a companion migration. */
export const migrateLegacyCompanion = migrateLegacyCreature
export const migrateLegacyCreatureState = migrateLegacyCreature
export const computeLegacyXp = computeLegacyCreatureXp
