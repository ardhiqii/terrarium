/**
 * Local-first guest profile persistence.
 *
 * This module intentionally has no dependency on `window`, `localStorage`, or
 * the current creature/XP implementation. The application supplies a storage
 * adapter at the boundary, which keeps profile serialization testable and
 * makes the eventual account-sync format explicit.
 */

export const GUEST_PROFILE_SCHEMA_VERSION = 1
export const GUEST_PROFILE_STORAGE_KEY = 'digital-garden:guest-profile'

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
  sourceBaselines: readonly LocalSourceBaseline[]
  collection: readonly GuestCollectionReference[]
  recoverabilityWarning: GuestRecoverabilityWarning
}

export interface CreateGuestProfileInput {
  guestId: string
  starterCompanionId: string
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
  now,
}: CreateGuestProfileInput): GuestProfile {
  assertNonEmptyString(guestId, 'guestId')
  assertNonEmptyString(starterCompanionId, 'starterCompanionId')
  assertNonEmptyString(now, 'now')

  return {
    schemaVersion: GUEST_PROFILE_SCHEMA_VERSION,
    guestId,
    createdAt: now,
    updatedAt: now,
    activeCompanionId: starterCompanionId,
    sourceBaselines: [],
    collection: [
      {
        referenceId: `${guestId}:starter`,
        companionId: starterCompanionId,
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
  return deserializeGuestProfile(storage.getItem(key))
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

  validateWarning(value.recoverabilityWarning)
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
