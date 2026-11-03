/**
 * Local-first guest profile persistence.
 *
 * This module intentionally has no dependency on `window`, `localStorage`, or
 * the current creature/XP implementation. The application supplies a storage
 * adapter at the boundary, which keeps profile serialization testable and
 * makes the eventual account-sync format explicit.
 */

import type { CareState } from './care/state'
import { createCareState, validateCareState } from './care/state'

/**
 * The collection entry that is actually active.
 *
 * THE SINGLE RESOLVER, used by the grid, the House, the snapshot and the
 * migration, so no surface has to decide for itself what "active" means. It
 * prefers the explicit `activeReferenceId`; if that entry is gone (a restore
 * pruned it, a hand-edited profile points nowhere) it falls back to the first
 * entry of the active species, and then to the first owned companion. It never
 * returns a second-best guess silently: the caller gets one entry or `null`.
 */
export function activeCollectionReference(
  profile: GuestProfile,
): GuestCollectionReference | null {
  if (profile.activeReferenceId) {
    const exact = profile.collection.find(
      (entry) => entry.referenceId === profile.activeReferenceId,
    )
    if (exact) return exact
  }
  return (
    profile.collection.find((entry) => entry.companionId === profile.activeCompanionId) ??
    profile.collection[0] ??
    null
  )
}

/** The active acquisition's reference id, or `null` for an empty collection. */
export function activeReferenceIdOf(profile: GuestProfile): string | null {
  return activeCollectionReference(profile)?.referenceId ?? null
}

/**
 * Fold duplicate STARTERS of one species into a single entry.
 *
 * WHY THIS EXISTS: a starter's reference id is `<guestId>:starter`, so two
 * profiles that both received a starter produce two entries when their
 * collections are unioned — signing in after using a guest profile left the user
 * owning two "your first" Pikachu. That is not a collected duplicate (those bank
 * Essence at draw time); it is the same grant arriving twice, and the collection
 * page has no way to explain it.
 *
 * ONLY STARTERS ARE COLLAPSED, and only when they share a species. Encounter and
 * history entries are left alone: those are real acquisitions.
 *
 * THE KEEPER, in order: the one the user made active, then one that is dressed
 * onto a repository, then the earliest acquired. That order keeps the visible
 * choice and, as far as possible, the user's resource spends.
 *
 * RETURNS THE SAME OBJECT when there is nothing to fold, so callers can persist
 * only on a real change and can treat identity as "unchanged".
 */
export function collapseDuplicateStarters(profile: GuestProfile, now: string): GuestProfile {
  const startersBySpecies = new Map<string, GuestCollectionReference[]>()
  for (const entry of profile.collection) {
    if (entry.acquisition !== 'starter') continue
    const group = startersBySpecies.get(entry.companionId) ?? []
    group.push(entry)
    startersBySpecies.set(entry.companionId, group)
  }

  const assignedReferences = new Set((profile.assignments ?? []).map((item) => item.referenceId))
  const dropped = new Map<string, string>() // dropped referenceId -> keeper referenceId

  for (const group of startersBySpecies.values()) {
    if (group.length < 2) continue
    const keep =
      group.find((entry) => entry.referenceId === profile.activeReferenceId) ??
      group.find((entry) => assignedReferences.has(entry.referenceId)) ??
      [...group].sort(
        (left, right) =>
          left.acquiredAt.localeCompare(right.acquiredAt) ||
          left.referenceId.localeCompare(right.referenceId),
      )[0]
    for (const entry of group) {
      if (entry.referenceId !== keep.referenceId) dropped.set(entry.referenceId, keep.referenceId)
    }
  }

  if (dropped.size === 0) return profile

  const collection = profile.collection.filter((entry) => !dropped.has(entry.referenceId))

  // Assignments are a spent resource: one companion dresses one repository. If
  // the keeper is already dressed, the dropped entry's repository is released
  // rather than double-booking the keeper, which the profile validator refuses.
  const keptAssignmentReferences = new Set<string>()
  const assignments = (profile.assignments ?? []).flatMap((assignment) => {
    const keeper = dropped.get(assignment.referenceId)
    if (keeper === undefined) {
      keptAssignmentReferences.add(assignment.referenceId)
      return [assignment]
    }
    if (keptAssignmentReferences.has(keeper)) {
      return []
    }
    keptAssignmentReferences.add(keeper)
    return [{ ...assignment, referenceId: keeper }]
  })

  // Resolve through the same helper the UI uses, then remap: a profile with no
  // explicit pointer resolves to the first entry of its species, which may be the
  // one being folded away.
  const currentActive = activeReferenceIdOf(profile)
  const activeReferenceId = currentActive
    ? (dropped.get(currentActive) ?? currentActive)
    : undefined

  return {
    ...profile,
    updatedAt: now,
    collection,
    assignments,
    ...(activeReferenceId ? { activeReferenceId } : {}),
  }
}

export const GUEST_PROFILE_SCHEMA_VERSION = 1
export const GUEST_PROFILE_STORAGE_KEY = 'terrarium:guest-profile'
const LEGACY_GUEST_PROFILE_STORAGE_KEY = 'digital-garden:guest-profile'

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

export interface RepoAssignmentRecord {
  /** GitHub's numeric repository id, stable across renames. */
  repositoryId: string
  /** The specific companion instance spent. Unique per acquisition. */
  referenceId: string
  /** Catalog id, carried so the sprite lookup has something to resolve. */
  companionId: string
  assignedAt: string
}

export interface PendingEggRecord {
  /** The draw that produced it. Becomes the collection `referenceId` on hatch. */
  drawId: string
  /** Catalog id, for drawing the egg in its species' colours. */
  companionId: string
  laidAt: string
}

export interface GuestProfile {
  schemaVersion: number
  guestId: string
  createdAt: string
  updatedAt: string
  activeCompanionId: string
  /**
   * Which ACQUISITION is active, not just which species.
   *
   * WHY THIS EXISTS NEXT TO `activeCompanionId`: the two answer different
   * questions. `activeCompanionId` is the catalog id and it is what XP,
   * progression and encounters are keyed on — two draws of the same species
   * genuinely share that ladder. The badge and the "make active" button,
   * however, are about one companion instance, and the collection can hold two
   * entries with the same `companionId` (different `referenceId`s). Comparing
   * tiles on the species id marked BOTH of them active, so "make active" on the
   * first Pikachu silently lit up the second one too.
   *
   * OPTIONAL, and resolved through `activeCollectionReference`, so every profile
   * written before this field existed still loads and still has an active
   * companion — the resolver falls back to the first entry of the active species.
   */
  activeReferenceId?: string
  sourceBaselines: readonly LocalSourceBaseline[]
  collection: readonly GuestCollectionReference[]
  /**
   * Companions drawn but not yet opened.
   *
   * OPTIONAL, and read as `?? []`, for the same reason as `assignments`: a
   * required field would fail validation for every profile written before eggs
   * existed, and the user would be silently reset to a fresh starter.
   */
  eggs?: readonly PendingEggRecord[]
  /**
   * Which companion is dressed onto which repository, if any.
   *
   * OPTIONAL, and read as `?? []`, so every profile written before this field
   * existed still loads. A required field would have failed `validateGuestProfile`
   * for every existing user and silently reset them to a fresh starter.
   */
  assignments?: readonly RepoAssignmentRecord[]
  /**
   * The condition layer: care timestamps, the item mint log, and what has been
   * spent.
   *
   * OPTIONAL, and read as `createCareState(profile.createdAt)`, for the same
   * reason as `eggs` and `assignments`: every profile written before the care
   * layer existed has no such field, and requiring it would fail validation and
   * silently reset the user to a fresh starter. A profile without it is treated
   * as a companion that has just started being looked after — which is exactly
   * true, because nothing had looked after it before.
   */
  care?: CareState
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
    activeReferenceId: `${guestId}:starter`,
    sourceBaselines: [],
    collection: [
      {
        referenceId: `${guestId}:starter`,
        companionId: starterCompanionId,
        acquiredAt: now,
        acquisition: 'starter',
      },
    ],
    eggs: [],
    assignments: [],
    care: createCareState(now),
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
  // A pointer, not an entitlement: it is accepted as any non-empty string and
  // resolved with a fallback, because a stale pointer must never cost the user
  // their profile. Unlike an assignment (which gates a resource), the worst a
  // bad value can do is highlight a different tile.
  if (value.activeReferenceId !== undefined) {
    assertNonEmptyString(value.activeReferenceId, 'activeReferenceId')
  }

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
  validateEggs(value.eggs, referenceIds)
  validateAssignments(value.assignments, referenceIds)
  // A MALFORMED CONDITION MUST NOT COST THE USER THEIR PROGRESSION. This field
  // is optional and entirely recoverable, but the profile around it holds the
  // collection, the active companion and every assignment. Letting a bad care
  // counter throw here made `deserializeGuestProfile` return null, which the
  // runtime treats as "no profile" and answers by minting a fresh guest: XP,
  // stage and collection gone because one number was negative. Strip the
  // condition layer and keep the profile.
  if (value.care !== undefined) {
    try {
      validateCareState(value.care)
    } catch {
      delete value.care
    }
  }
}

/**
 * Eggs are validated against the collection read alongside them.
 *
 * An egg whose draw is already in the collection would hatch into a second
 * collection entry for one roll, and the profile is user-writable, so this has to
 * hold on READ and not only on write.
 */
function validateEggs(value: unknown, ownedReferenceIds: ReadonlySet<string>): void {
  // Absent is valid: every profile written before eggs existed.
  if (value === undefined) return
  if (!Array.isArray(value)) {
    throw new TypeError('eggs must be an array')
  }

  const drawIds = new Set<string>()
  for (const egg of value) {
    if (!isRecord(egg)) throw new TypeError('Invalid egg')
    assertNonEmptyString(egg.drawId, 'drawId')
    assertNonEmptyString(egg.companionId, 'companionId')
    assertNonEmptyString(egg.laidAt, 'laidAt')

    if (drawIds.has(egg.drawId)) {
      throw new TypeError('eggs contains a duplicate drawId')
    }
    drawIds.add(egg.drawId)

    if (ownedReferenceIds.has(egg.drawId)) {
      throw new TypeError('egg is already hatched into the collection')
    }
  }
}

/**
 * Assignments are validated against the collection that was just read.
 *
 * A profile is user-writable (it lives in localStorage), so the invariant "you
 * cannot dress more repositories than you own companions" has to be enforced on
 * READ, not only on write. Without this, editing localStorage once would let a
 * single companion dress every repository and the bound would be decorative.
 */
function validateAssignments(
  value: unknown,
  ownedReferenceIds: ReadonlySet<string>,
): void {
  // Absent is valid: every profile written before assignments existed.
  if (value === undefined) return
  if (!Array.isArray(value)) {
    throw new TypeError('assignments must be an array')
  }

  const repositoryIds = new Set<string>()
  const spent = new Set<string>()
  for (const assignment of value) {
    if (!isRecord(assignment)) throw new TypeError('Invalid assignment')
    assertNonEmptyString(assignment.repositoryId, 'repositoryId')
    assertNonEmptyString(assignment.referenceId, 'referenceId')
    assertNonEmptyString(assignment.companionId, 'companionId')
    assertNonEmptyString(assignment.assignedAt, 'assignedAt')

    if (repositoryIds.has(assignment.repositoryId)) {
      throw new TypeError('assignments contains a duplicate repositoryId')
    }
    repositoryIds.add(assignment.repositoryId)

    if (!ownedReferenceIds.has(assignment.referenceId)) {
      throw new TypeError('assignment references a companion that is not owned')
    }
    if (spent.has(assignment.referenceId)) {
      throw new TypeError('assignments spends the same companion twice')
    }
    spent.add(assignment.referenceId)
  }
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
