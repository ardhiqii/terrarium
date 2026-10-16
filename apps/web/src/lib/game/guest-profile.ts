/**
 * Local-first guest profile persistence.
 *
 * This module intentionally has no dependency on `window`, `localStorage`, or
 * the current creature/XP implementation. The application supplies a storage
 * adapter at the boundary, which keeps profile serialization testable and
 * makes the eventual account-sync format explicit.
 */

import {
  COMPANION_CATALOG_VERSION,
  isStarterEligible,
  selectStarterCompanion,
  type CompanionCatalog,
  type RandomSource,
} from './companion-catalog'

export const GUEST_PROFILE_SCHEMA_VERSION = 1
export const GUEST_PROFILE_STORAGE_KEY = 'terrarium:guest-profile'
const LEGACY_GUEST_PROFILE_STORAGE_KEY = 'digital-garden:guest-profile'

/** Stable migration namespace for the legacy CreatureState projection. */
export const LEGACY_CREATURE_MIGRATION_VERSION = 'legacy-creature:v1'
export const LEGACY_MIGRATION_VERSION = LEGACY_CREATURE_MIGRATION_VERSION

export type GuestSourceKind = 'notes' | 'github'

/**
 * The last locally observed snapshot of one mounted or connected source.
 * `metrics` is intentionally extensible because notes and GitHub expose
 * different counters. The activity engine, not this persistence layer,
 * decides which metric deltas award XP.
 */
export interface LocalSourceBaseline {
  sourceId: string
  kind: GuestSourceKind
  fingerprint: string
  observedAt: string
  metrics: Readonly<Record<string, number>>
}

export type GuestCompanionAcquisition = 'starter' | 'history' | 'encounter'

export type ActiveSelectionProvenance = 'starter' | 'user' | 'migration'

/**
 * Serializable provenance for the currently active companion. Keeping this
 * beside (rather than replacing) `activeCompanionId` lets old profile and
 * snapshot callers continue to read the original field.
 */
export interface ActiveCompanionSelection {
  companionId: string
  provenance: ActiveSelectionProvenance
  selectedAt: string
  migrationVersion?: string
}

/** Alias used by snapshot adapters that call this an active selection. */
export type ActiveSelection = ActiveCompanionSelection

/**
 * A non-replayable XP grant from a versioned legacy projection. It is kept
 * separate from normalized source events so migration cannot invent proofs,
 * caps, or encounter triggers for historical aggregate counters.
 */
export interface LegacyXpCredit {
  creditId: string
  migrationVersion: string
  companionId: string
  totalXp: number
  sourceFingerprint: string
}

/**
 * A reference to an acquired companion. Repeated `companionId` values are
 * valid and represent duplicate encounters without storing companion XP here.
 */
export interface GuestCollectionReference {
  referenceId: string
  companionId: string
  acquiredAt: string
  acquisition: GuestCompanionAcquisition
}

export type GuestRecoverabilityWarningStatus =
  | 'unseen'
  | 'shown'
  | 'dismissed'

export interface GuestRecoverabilityWarning {
  status: GuestRecoverabilityWarningStatus
  lastShownAt: string | null
  dismissedAt: string | null
  updatedAt: string
}

export interface GuestProfile {
  schemaVersion: number
  guestId: string
  createdAt: string
  updatedAt: string
  activeCompanionId: string
  /** Optional on schema-v1 profiles; new profiles always persist it. */
  activeSelection?: ActiveCompanionSelection
  /** Content manifest used when the profile selected its starter. */
  catalogVersion?: string
  /** Marker for a completed versioned legacy migration. */
  migrationVersion?: string
  /** Aggregate historical grants, never replayed as source events. */
  legacyCredits?: readonly LegacyXpCredit[]
  sourceBaselines: readonly LocalSourceBaseline[]
  collection: readonly GuestCollectionReference[]
  recoverabilityWarning: GuestRecoverabilityWarning
}

export interface CreateGuestProfileInput {
  guestId: string
  /** Existing callers may provide an explicit starter ID. */
  starterCompanionId?: string
  /** New callers can let the domain choose an eligible base-stage starter. */
  catalog?: CompanionCatalog
  random?: RandomSource
  /** Alias for callers that name the injected source `rng`. */
  rng?: RandomSource
  now: string
}

/**
 * A localStorage-shaped adapter. The implementation is supplied by the
 * browser boundary so importing this module is safe during SSR and tests.
 */
export interface GuestProfileStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** A deterministic storage adapter for unit tests and non-browser callers. */
export class InMemoryGuestProfileStorage implements GuestProfileStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

export function createGuestProfile({
  guestId,
  starterCompanionId,
  catalog,
  random,
  rng,
  now,
}: CreateGuestProfileInput): GuestProfile {
  assertNonEmptyString(guestId, 'guestId')
  assertNonEmptyString(now, 'now')
  const selectedStarter = starterCompanionId ?? (
    catalog
      ? selectStarterCompanion(catalog, random ?? rng).id
      : null
  )
  if (!selectedStarter) {
    throw new TypeError('starterCompanionId or catalog is required')
  }
  assertNonEmptyString(selectedStarter, 'starterCompanionId')
  if (catalog && starterCompanionId && !isStarterEligible(catalog, selectedStarter)) {
    throw new TypeError('starterCompanionId must be an eligible base-stage starter')
  }

  return {
    schemaVersion: GUEST_PROFILE_SCHEMA_VERSION,
    guestId,
    createdAt: now,
    updatedAt: now,
    activeCompanionId: selectedStarter,
    activeSelection: {
      companionId: selectedStarter,
      provenance: 'starter',
      selectedAt: now,
    },
    catalogVersion: catalog?.version ?? COMPANION_CATALOG_VERSION,
    legacyCredits: [],
    sourceBaselines: [],
    collection: [
      {
        referenceId: `${guestId}:starter`,
        companionId: selectedStarter,
        acquiredAt: now,
        acquisition: 'starter',
      },
    ],
    recoverabilityWarning: {
      status: 'unseen',
      lastShownAt: null,
      dismissedAt: null,
      updatedAt: now,
    },
  }
}

/**
 * Resolve provenance for old schema-v1 profiles that only persisted an active
 * ID. A profile pointing at its original starter reference is still untouched;
 * any other owned reference is treated as an explicit user selection.
 */
export function getActiveCompanionSelection(
  profile: GuestProfile,
): ActiveCompanionSelection {
  const persisted = profile.activeSelection
  if (persisted?.companionId === profile.activeCompanionId) return persisted

  const starterReference = profile.collection.find((reference) =>
    reference.referenceId === `${profile.guestId}:starter` &&
    reference.companionId === profile.activeCompanionId &&
    reference.acquisition === 'starter',
  )
  return {
    companionId: profile.activeCompanionId,
    provenance: starterReference ? 'starter' : 'user',
    selectedAt: starterReference?.acquiredAt ?? profile.updatedAt,
  }
}

/** True only while the active ID still represents the untouched starter. */
export function hasUntouchedStarterSelection(profile: GuestProfile): boolean {
  return getActiveCompanionSelection(profile).provenance === 'starter' &&
    profile.collection.some((reference) =>
      reference.referenceId === `${profile.guestId}:starter` &&
      reference.companionId === profile.activeCompanionId &&
      reference.acquisition === 'starter',
    )
}

/**
 * Set active selection without allowing an unowned companion ID into the
 * profile. The migration path uses the same helper with `provenance: migration`.
 */
export function setActiveCompanionSelection(
  profile: GuestProfile,
  companionId: string,
  provenance: ActiveSelectionProvenance,
  selectedAt: string,
  migrationVersion?: string,
): GuestProfile {
  assertNonEmptyString(companionId, 'companionId')
  assertNonEmptyString(selectedAt, 'selectedAt')
  if (!profile.collection.some((reference) => reference.companionId === companionId)) {
    throw new Error('active companion must be owned by the profile')
  }
  return {
    ...profile,
    activeCompanionId: companionId,
    activeSelection: {
      companionId,
      provenance,
      selectedAt,
      ...(migrationVersion ? { migrationVersion } : {}),
    },
  }
}

/** Common alternative name for persistence and sync adapters. */
export const resolveActiveSelection = getActiveCompanionSelection

/**
 * Deduplicates credit IDs defensively when rebuilding state from untrusted
 * in-memory data. Serialization is stricter and rejects duplicate IDs.
 */
export function dedupeLegacyXpCredits(
  credits: readonly LegacyXpCredit[] | undefined,
): readonly LegacyXpCredit[] {
  const seen = new Set<string>()
  const result: LegacyXpCredit[] = []
  for (const credit of credits ?? []) {
    if (!isValidLegacyXpCredit(credit) || seen.has(credit.creditId)) continue
    seen.add(credit.creditId)
    result.push(credit)
  }
  return result
}

export function sumLegacyXpPerCompanion(
  credits: readonly LegacyXpCredit[] | undefined,
): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {}
  for (const credit of dedupeLegacyXpCredits(credits)) {
    const next = (totals[credit.companionId] ?? 0) + credit.totalXp
    // Keep malformed/hostile aggregates from turning the derived projection
    // into Infinity. Snapshot validation still rejects invalid individual
    // credits at the persistence boundary.
    totals[credit.companionId] = Number.isFinite(next) ? next : Number.MAX_SAFE_INTEGER
  }
  return totals
}

/**
 * Serialize only validated state. Throwing here catches programmer errors at
 * the write boundary; untrusted persisted data is handled by deserialization.
 */
export function serializeGuestProfile(profile: GuestProfile): string {
  validateGuestProfile(profile)
  return JSON.stringify(profile)
}

/**
 * Parse persisted state defensively. Invalid JSON, unsupported schema versions,
 * and malformed fields all become `null`, allowing the caller to start a fresh
 * guest profile and present its recoverability warning.
 */
export function deserializeGuestProfile(serialized: string | null): GuestProfile | null {
  if (serialized === null) return null

  try {
    const value: unknown = JSON.parse(serialized)
    if (!isRecord(value)) return null
    validateGuestProfile(value)
    return value as unknown as GuestProfile
  } catch {
    return null
  }
}

export function loadGuestProfile(
  storage: GuestProfileStorage,
  key = GUEST_PROFILE_STORAGE_KEY
): GuestProfile | null {
  const serialized = storage.getItem(key)
  const profile = deserializeGuestProfile(
    serialized ??
      (key === GUEST_PROFILE_STORAGE_KEY
        ? storage.getItem(LEGACY_GUEST_PROFILE_STORAGE_KEY)
        : null)
  )
  if (serialized === null && profile !== null && key === GUEST_PROFILE_STORAGE_KEY) {
    saveGuestProfile(storage, profile, key)
  }
  return profile
}

export function saveGuestProfile(
  storage: GuestProfileStorage,
  profile: GuestProfile,
  key = GUEST_PROFILE_STORAGE_KEY
): void {
  storage.setItem(key, serializeGuestProfile(profile))
}

export function clearGuestProfile(
  storage: GuestProfileStorage,
  key = GUEST_PROFILE_STORAGE_KEY
): void {
  storage.removeItem(key)
  if (key === GUEST_PROFILE_STORAGE_KEY) {
    storage.removeItem(LEGACY_GUEST_PROFILE_STORAGE_KEY)
  }
}

function validateGuestProfile(value: unknown): void {
  if (!isRecord(value)) throw new TypeError('Guest profile must be an object')
  if (value.schemaVersion !== GUEST_PROFILE_SCHEMA_VERSION) {
    throw new TypeError('Unsupported guest profile schema version')
  }

  assertNonEmptyString(value.guestId, 'guestId')
  assertNonEmptyString(value.createdAt, 'createdAt')
  assertNonEmptyString(value.updatedAt, 'updatedAt')
  assertNonEmptyString(value.activeCompanionId, 'activeCompanionId')

  if (!Array.isArray(value.sourceBaselines)) {
    throw new TypeError('sourceBaselines must be an array')
  }
  if (!Array.isArray(value.collection)) {
    throw new TypeError('collection must be an array')
  }

  const sourceIds = new Set<string>()
  for (const baseline of value.sourceBaselines) {
    validateSourceBaseline(baseline)
    if (sourceIds.has(baseline.sourceId)) {
      throw new TypeError('sourceBaselines contains a duplicate sourceId')
    }
    sourceIds.add(baseline.sourceId)
  }

  const referenceIds = new Set<string>()
  for (const reference of value.collection) {
    validateCollectionReference(reference)
    if (referenceIds.has(reference.referenceId)) {
      throw new TypeError('collection contains a duplicate referenceId')
    }
    referenceIds.add(reference.referenceId)
  }
  if (!value.collection.some((reference) => reference.companionId === value.activeCompanionId)) {
    throw new TypeError('activeCompanionId must be owned by the profile')
  }

  if (value.activeSelection !== undefined) {
    validateActiveSelection(value.activeSelection)
    if (value.activeSelection.companionId !== value.activeCompanionId) {
      throw new TypeError('activeSelection must match activeCompanionId')
    }
  }
  if (value.catalogVersion !== undefined) assertNonEmptyString(value.catalogVersion, 'catalogVersion')
  if (value.migrationVersion !== undefined) assertNonEmptyString(value.migrationVersion, 'migrationVersion')
  if (value.legacyCredits !== undefined) {
    if (!Array.isArray(value.legacyCredits)) throw new TypeError('legacyCredits must be an array')
    const creditIds = new Set<string>()
    for (const credit of value.legacyCredits) {
      validateLegacyXpCredit(credit)
      if (creditIds.has(credit.creditId)) throw new TypeError('legacyCredits contains a duplicate creditId')
      creditIds.add(credit.creditId)
    }
  }

  validateWarning(value.recoverabilityWarning)
}

export function validateLegacyXpCredit(value: unknown): asserts value is LegacyXpCredit {
  if (!isRecord(value)) throw new TypeError('Invalid legacy XP credit')
  assertNonEmptyString(value.creditId, 'legacy creditId')
  assertNonEmptyString(value.migrationVersion, 'legacy migrationVersion')
  assertNonEmptyString(value.companionId, 'legacy companionId')
  if (typeof value.totalXp !== 'number' || !Number.isFinite(value.totalXp) || value.totalXp < 0) {
    throw new TypeError('legacy totalXp must be a finite non-negative number')
  }
  assertNonEmptyString(value.sourceFingerprint, 'legacy sourceFingerprint')
}

function isValidLegacyXpCredit(value: unknown): value is LegacyXpCredit {
  try {
    validateLegacyXpCredit(value)
    return true
  } catch {
    return false
  }
}

function validateActiveSelection(value: unknown): asserts value is ActiveCompanionSelection {
  if (!isRecord(value)) throw new TypeError('Invalid activeSelection')
  assertNonEmptyString(value.companionId, 'activeSelection.companionId')
  if (value.provenance !== 'starter' && value.provenance !== 'user' && value.provenance !== 'migration') {
    throw new TypeError('Invalid activeSelection.provenance')
  }
  assertNonEmptyString(value.selectedAt, 'activeSelection.selectedAt')
  if (value.migrationVersion !== undefined) assertNonEmptyString(value.migrationVersion, 'activeSelection.migrationVersion')
}

function validateSourceBaseline(value: unknown): asserts value is LocalSourceBaseline {
  if (!isRecord(value)) throw new TypeError('Invalid source baseline')
  assertNonEmptyString(value.sourceId, 'sourceId')
  if (value.kind !== 'notes' && value.kind !== 'github') {
    throw new TypeError('Invalid source baseline kind')
  }
  assertNonEmptyString(value.fingerprint, 'fingerprint')
  assertNonEmptyString(value.observedAt, 'observedAt')

  if (!isRecord(value.metrics)) throw new TypeError('Baseline metrics must be an object')
  for (const [name, metric] of Object.entries(value.metrics)) {
    assertNonEmptyString(name, 'metric name')
    if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) {
      throw new TypeError('Baseline metrics must be finite non-negative numbers')
    }
  }
}

function validateCollectionReference(
  value: unknown
): asserts value is GuestCollectionReference {
  if (!isRecord(value)) throw new TypeError('Invalid collection reference')
  assertNonEmptyString(value.referenceId, 'referenceId')
  assertNonEmptyString(value.companionId, 'companionId')
  assertNonEmptyString(value.acquiredAt, 'acquiredAt')
  if (
    value.acquisition !== 'starter' &&
    value.acquisition !== 'history' &&
    value.acquisition !== 'encounter'
  ) {
    throw new TypeError('Invalid companion acquisition')
  }
}

function validateWarning(value: unknown): asserts value is GuestRecoverabilityWarning {
  if (!isRecord(value)) throw new TypeError('Invalid recoverability warning')
  if (
    value.status !== 'unseen' &&
    value.status !== 'shown' &&
    value.status !== 'dismissed'
  ) {
    throw new TypeError('Invalid recoverability warning status')
  }
  if (value.lastShownAt !== null) assertNonEmptyString(value.lastShownAt, 'lastShownAt')
  if (value.dismissedAt !== null) assertNonEmptyString(value.dismissedAt, 'dismissedAt')
  assertNonEmptyString(value.updatedAt, 'warning updatedAt')
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
