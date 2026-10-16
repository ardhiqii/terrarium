/**
 * Versioned, derived-only sync contract for the product companion loop.
 *
 * This is intentionally a different contract from the legacy snapshot in
 * `snapshot.ts`. It is built from ProductState, but it does not serialize the
 * source objects that produced that state. In particular, note contents,
 * note titles/paths, repository descriptions, tags, and arbitrary text never
 * cross this boundary.
 */

import {
  asCompanionId,
  asEventId,
  sumXpPerCompanion,
  type EventCategory,
  type EventLedger,
  type EventMetadataValue,
  type NormalizedEvent,
  type Provenance,
  type SourceKind,
} from '../game/events'
import {
  COMPANION_CATALOG_VERSION,
  PROTOTYPE_COMPANION_CATALOG,
  resolveCompanionProgression,
  type CompanionCatalog,
} from '../game/companion-catalog'
import { createProductState, type ProductState } from '../game/product-state'
import {
  DEFAULT_ENCOUNTER_CONFIG,
  opaqueEncounterTriggerId,
  type EncounterState,
  type PersistedEncounterDraw,
} from '../game/encounters'
import {
  getActiveCompanionSelection,
  sumLegacyXpPerCompanion,
  type ActiveCompanionSelection,
  type GuestCollectionReference,
  type GuestProfile,
  type LegacyXpCredit,
  type LocalSourceBaseline,
} from '../game/guest-profile'
import type { ProductCompanionState } from '../game/product-state'
import { productEventId } from './product-event-id'

/** The first product snapshot version shipped before companion migration fields. */
export const PRODUCT_SNAPSHOT_LEGACY_SCHEMA_VERSION = 1
/** Current product snapshot version. Version 1 is up-converted on read. */
export const PRODUCT_SNAPSHOT_SCHEMA_VERSION = 2
/** Descriptive alias for callers that distinguish this from the legacy snapshot. */
export const PRODUCT_SYNC_SNAPSHOT_SCHEMA_VERSION = PRODUCT_SNAPSHOT_SCHEMA_VERSION

/** Only machine-derived evidence is allowed in the synced event metadata. */
export interface ProductEventMetadata {
  readonly activityCount?: number
  readonly bucket?: number
  readonly number?: number
  readonly repositoryIdHash?: string
  readonly linkedPullRequestIdHash?: string
  readonly pullRequestIdHash?: string
  readonly sessionBucket?: string
}

export interface ProductSnapshotEvent {
  /** Opaque stable digest of the source event ID. */
  readonly eventId: string
  readonly companionId: string
  readonly source: SourceKind
  readonly provenance: Provenance
  readonly category: EventCategory
  readonly occurredAt: string
  /** Server-issued HMAC receipt for verified GitHub events. */
  readonly verifiedProof?: string
  readonly cap?: { readonly key: string; readonly limit: number }
  readonly metadata?: ProductEventMetadata
}

export interface ProductSnapshotCompanion {
  readonly companionId: string
  readonly familyId: string | null
  readonly xp: number
  readonly essence: number
  readonly encounterCount: number
  readonly progression: {
    readonly stepId: string
    readonly formId: string
    readonly nextStepId: string | null
    readonly nextFormId: string | null
  } | null
}

export interface ProductSnapshotCollectionReference {
  /** Opaque stable digest of the local reference ID. */
  readonly referenceId: string
  readonly companionId: string
  readonly acquiredAt: string
  readonly acquisition: GuestCollectionReference['acquisition']
}

export interface ProductSnapshotSourceBaseline {
  /** Opaque stable digest of the mounted source identity and fingerprint. */
  readonly sourceIdHash: string
  readonly kind: LocalSourceBaseline['kind']
  readonly fingerprintHash: string
  readonly observedAt: string
  readonly metrics: Readonly<Record<string, number>>
}

export interface ProductSnapshotWarning {
  readonly status: GuestProfile['recoverabilityWarning']['status']
  readonly lastShownAt: string | null
  readonly dismissedAt: string | null
  readonly updatedAt: string
}

/** Persisted active-selection provenance, kept explicit at the sync boundary. */
export type ProductSnapshotActiveSelection = ActiveCompanionSelection

/** Versioned non-replayable XP grants from a legacy aggregate. */
export type ProductSnapshotLegacyCredit = LegacyXpCredit

export interface ProductSnapshotWeight {
  readonly companionId: string
  readonly baseWeight: number
  readonly tagMatchCount: number
  readonly languageMatchCount: number
  readonly fileTypeMatchCount: number
  readonly tagBonus: number
  readonly languageBonus: number
  readonly fileTypeBonus: number
  readonly finalWeight: number
}

export interface ProductSnapshotDraw {
  /** Opaque stable digest of the persisted draw identity. */
  readonly id: string
  readonly sequence: number
  /** Opaque stable digests; raw trigger and seed strings stay local. */
  readonly triggerId: string
  readonly seed: string
  readonly selectedCompanionId: string
  readonly selectedFamilyId: string
  readonly isDuplicate: boolean
  readonly essenceAwarded: number
  readonly weights: readonly ProductSnapshotWeight[]
}

export interface ProductSnapshotEncounters {
  readonly meter: number
  readonly totalProgress: number
  readonly nextSequence: number
  readonly draws: readonly ProductSnapshotDraw[]
  readonly processedTriggerIds: readonly string[]
  /** Opaque trigger -> progress contributions; optional for old v2 snapshots. */
  readonly progressByTriggerId?: Readonly<Record<string, number>>
  readonly essenceByFamily: Readonly<Record<string, number>>
}

export interface ProductSnapshot {
  readonly schemaVersion: number
  readonly guestId: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly generatedAt: string
  readonly activeCompanionId: string
  readonly activeSelection: ProductSnapshotActiveSelection
  readonly catalogVersion: string
  readonly migrationVersion?: string
  readonly legacyCredits: readonly ProductSnapshotLegacyCredit[]
  readonly companions: readonly ProductSnapshotCompanion[]
  readonly collection: readonly ProductSnapshotCollectionReference[]
  readonly sourceBaselines: readonly ProductSnapshotSourceBaseline[]
  readonly recoverabilityWarning: ProductSnapshotWarning
  readonly events: readonly ProductSnapshotEvent[]
  readonly encounters: ProductSnapshotEncounters
}

/** Canonical name for the new product sync payload. */
export type ProductSyncedSnapshot = ProductSnapshot

const EVENT_CATEGORIES: readonly EventCategory[] = [
  'qualifying-active-day',
  'work-session',
  'new-note',
  'new-words',
  'resolved-wikilink',
  'merged-pull-request',
  'published-release',
  'closed-linked-issue',
  'successful-ci',
]

const SOURCE_KINDS: readonly SourceKind[] = ['built-in-editor', 'mounted-markdown', 'github']
const PROVENANCES: readonly Provenance[] = ['local', 'verified']
const BASELINE_METRICS = new Set([
  'noteCount',
  'projectCount',
  'totalWords',
  'resolvedWikilinks',
  'commits',
  'mergedPullRequests',
  'releases',
  'closedLinkedIssues',
  'successfulCi',
])
const MAX_PRODUCT_STRING_LENGTH = 512
const MAX_PRODUCT_EVENTS = 5000
const MAX_PRODUCT_COLLECTION_REFERENCES = 2000
const MAX_PRODUCT_COMPANIONS = 200
const MAX_PRODUCT_CREDITS = 100
const MAX_PRODUCT_BASELINES = 500
const MAX_PRODUCT_DRAWS = 2000
const MAX_PRODUCT_DRAW_WEIGHTS = 200
const MAX_PRODUCT_TRIGGERS = 5000
/** Encounter state is compact, but it must not carry unbounded forged work. */
const MAX_ENCOUNTER_METER = DEFAULT_ENCOUNTER_CONFIG.threshold
const MAX_ENCOUNTER_TOTAL_PROGRESS = MAX_PRODUCT_EVENTS * DEFAULT_ENCOUNTER_CONFIG.threshold
const MAX_ENCOUNTER_ESSENCE_PER_DRAW = 8
const MAX_ENCOUNTER_ESSENCE = MAX_PRODUCT_DRAWS * MAX_ENCOUNTER_ESSENCE_PER_DRAW

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function progressTotal(progress: Readonly<Record<string, number>>): number {
  return Object.values(progress).reduce((total, value) => total + value, 0)
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  maxLength = MAX_PRODUCT_STRING_LENGTH,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  if (value.length > maxLength) throw new TypeError(`${field} is too long`)
}

function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative safe integer`)
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field)
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be a timestamp`)
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  field: string,
): void {
  const allowed = new Set([...required, ...optional])
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new TypeError(`${field} has unknown field(s): ${unknown.join(', ')}`)
  const missing = required.filter((key) => !(key in value))
  if (missing.length > 0) throw new TypeError(`${field} is missing field(s): ${missing.join(', ')}`)
}

function assertEnum<T extends string>(value: unknown, values: readonly T[], field: string): asserts value is T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new TypeError(`${field} is not a supported value`)
  }
}

const OPAQUE_ID_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{8}$/u

/**
 * A deterministic opaque ID suitable for sync while remaining stable across devices.
 *
 * Idempotent by design, like `productEventId`: a restored snapshot only carries
 * the opaque value, so re-snapshotting it must reproduce the exact same string
 * (the server receipt signs the cap key, and a second hash would break it).
 */
function opaqueId(value: string, prefix: string): string {
  if (prefix === 'event') return productEventId(value)
  const marker = `${prefix}-`
  if (value.startsWith(marker) && OPAQUE_ID_SUFFIX.test(value.slice(marker.length))) return value
  let first = 2166136261
  let second = 2246822519
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ (code + index), 3266489917)
  }
  return `${prefix}-${(first >>> 0).toString(16).padStart(8, '0')}-${(second >>> 0).toString(16).padStart(8, '0')}`
}

/** Normalize a caller-provided identifier into the bounded opaque form used by sync. */
export function toOpaqueProductId(value: string, prefix: string): string {
  return opaqueId(value, prefix)
}

function safeMetadata(metadata: Readonly<Record<string, EventMetadataValue>> | undefined): ProductEventMetadata | undefined {
  if (!metadata) return undefined
  const result = {} as { -readonly [K in keyof ProductEventMetadata]?: ProductEventMetadata[K] }
  if (typeof metadata.activityCount === 'number') result.activityCount = metadata.activityCount
  if (typeof metadata.bucket === 'number') result.bucket = metadata.bucket
  if (typeof metadata.number === 'number') result.number = metadata.number
  if (typeof metadata.repositoryIdHash === 'string') {
    result.repositoryIdHash = metadata.repositoryIdHash
  } else if (typeof metadata.repositoryId === 'string') {
    result.repositoryIdHash = opaqueId(metadata.repositoryId, 'repo')
  }
  if (typeof metadata.linkedPullRequestIdHash === 'string') {
    result.linkedPullRequestIdHash = metadata.linkedPullRequestIdHash
  } else if (typeof metadata.linkedPullRequestId === 'string') {
    result.linkedPullRequestIdHash = opaqueId(metadata.linkedPullRequestId, 'pr')
  }
  if (typeof metadata.pullRequestIdHash === 'string') {
    result.pullRequestIdHash = metadata.pullRequestIdHash
  } else if (typeof metadata.pullRequestId === 'string') {
    result.pullRequestIdHash = opaqueId(metadata.pullRequestId, 'pr')
  }
  if (typeof metadata.sessionBucket === 'string' && /^\d{4}-\d{2}-\d{2}-\d+$/u.test(metadata.sessionBucket)) {
    result.sessionBucket = metadata.sessionBucket
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function productSnapshotEvent(
  event: NormalizedEvent,
  verifiedProof?: string,
  downgradeUnprovenVerified = false,
): ProductSnapshotEvent {
  const eventId = opaqueId(event.eventId, 'event')
  const trustedVerified = event.provenance !== 'verified' || Boolean(verifiedProof)
  return {
    eventId,
    companionId: event.companionId,
    source: event.source,
    provenance: downgradeUnprovenVerified && !trustedVerified ? 'local' : event.provenance,
    category: event.category,
    occurredAt: event.occurredAt,
    ...(trustedVerified && verifiedProof ? { verifiedProof } : {}),
    ...(event.cap
      ? { cap: { key: opaqueId(event.cap.key, 'cap'), limit: event.cap.limit } }
      : {}),
    ...(safeMetadata(event.metadata) ? { metadata: safeMetadata(event.metadata) } : {}),
  }
}

function snapshotCompanion(companion: ProductCompanionState): ProductSnapshotCompanion {
  return {
    companionId: companion.companionId,
    familyId: companion.familyId,
    xp: companion.xp,
    essence: companion.essence,
    encounterCount: companion.encounterCount,
    progression: companion.progression
      ? {
          stepId: companion.progression.step.id,
          formId: companion.progression.form.id,
          nextStepId: companion.progression.nextStep?.id ?? null,
          nextFormId: companion.progression.nextForm?.id ?? null,
        }
      : null,
  }
}

function snapshotCollectionReference(reference: GuestCollectionReference): ProductSnapshotCollectionReference {
  return {
    referenceId: opaqueId(reference.referenceId, 'ref'),
    companionId: reference.companionId,
    acquiredAt: reference.acquiredAt,
    acquisition: reference.acquisition,
  }
}

function snapshotBaseline(baseline: LocalSourceBaseline): ProductSnapshotSourceBaseline {
  const metrics: Record<string, number> = {}
  for (const [key, value] of Object.entries(baseline.metrics)) {
    if (BASELINE_METRICS.has(key)) metrics[key] = value
  }
  return {
    sourceIdHash: opaqueId(baseline.sourceId, 'source'),
    kind: baseline.kind,
    fingerprintHash: opaqueId(baseline.fingerprint, 'fingerprint'),
    observedAt: baseline.observedAt,
    metrics,
  }
}

function snapshotWeight(weight: PersistedEncounterDraw['weights'][number]): ProductSnapshotWeight {
  return {
    companionId: weight.companionId,
    baseWeight: weight.baseWeight,
    tagMatchCount: weight.matchedTags.length,
    languageMatchCount: weight.matchedLanguages.length,
    fileTypeMatchCount: weight.matchedFileTypes.length,
    tagBonus: weight.tagBonus,
    languageBonus: weight.languageBonus,
    fileTypeBonus: weight.fileTypeBonus,
    finalWeight: weight.finalWeight,
  }
}

function snapshotDraw(draw: PersistedEncounterDraw): ProductSnapshotDraw {
  return {
    id: opaqueId(draw.id, 'draw'),
    sequence: draw.sequence,
    triggerId: opaqueId(draw.triggerId, 'trigger'),
    seed: opaqueId(draw.seed, 'seed'),
    selectedCompanionId: draw.selectedCompanionId,
    selectedFamilyId: draw.selectedFamilyId,
    isDuplicate: draw.isDuplicate,
    essenceAwarded: draw.essenceAwarded,
    weights: draw.weights.map(snapshotWeight),
  }
}

function snapshotEncounters(encounters: EncounterState): ProductSnapshotEncounters {
  const progressEntries = Object.entries(encounters.progressByTriggerId ?? {})
    .filter(([, progress]) => Number.isFinite(progress) && progress >= 0)
  if (progressEntries.length > MAX_PRODUCT_TRIGGERS) {
    throw new TypeError('encounters.progressByTriggerId is too large')
  }
  return {
    meter: encounters.meter,
    totalProgress: encounters.totalProgress,
    nextSequence: encounters.nextSequence,
    draws: encounters.draws.map(snapshotDraw),
    processedTriggerIds: encounters.processedTriggerIds.map((id) => opaqueEncounterTriggerId(id)),
    ...(progressEntries.length > 0
      ? { progressByTriggerId: Object.fromEntries(progressEntries.map(([id, progress]) => [opaqueEncounterTriggerId(id), progress])) }
      : {}),
    essenceByFamily: { ...encounters.essenceByFamily },
  }
}

/** Convert local raw trigger IDs to the same opaque IDs used by cloud state. */
export function normalizeEncounterStateForSync(encounters: EncounterState): EncounterState {
  const snapshot = snapshotEncounters(encounters)
  return {
    meter: snapshot.meter,
    totalProgress: snapshot.totalProgress,
    nextSequence: snapshot.nextSequence,
    draws: snapshot.draws.map((draw): PersistedEncounterDraw => ({
      ...draw,
      weights: draw.weights.map((weight) => ({
        ...weight,
        matchedTags: [],
        matchedLanguages: [],
        matchedFileTypes: [],
      })),
    })),
    processedTriggerIds: [...snapshot.processedTriggerIds],
    progressByTriggerId: { ...snapshot.progressByTriggerId },
    essenceByFamily: { ...snapshot.essenceByFamily },
  }
}

/**
 * Compact only events whose IDs the caller has seen in a successful server
 * snapshot. A receipt proves origin, not that the product upload committed;
 * unverified/local evidence and receipt-backed-but-unsaved events therefore
 * remain in the payload or fail closed at the existing validator.
 */
function compactSnapshotEvents(
  events: readonly ProductSnapshotEvent[],
  durableEventIds: ReadonlySet<string> = new Set(),
): ProductSnapshotEvent[] {
  if (events.length <= MAX_PRODUCT_EVENTS) return [...events]
  const removable = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => (
      durableEventIds.has(event.eventId) &&
      typeof event.verifiedProof === 'string' &&
      event.verifiedProof.length > 0
    ))
    .sort((left, right) => left.event.occurredAt.localeCompare(right.event.occurredAt) || left.index - right.index)
  const removeCount = events.length - MAX_PRODUCT_EVENTS
  if (removable.length < removeCount) throw new TypeError('events is too large')
  const removed = new Set(removable.slice(0, removeCount).map(({ index }) => index))
  return events.filter((_, index) => !removed.has(index))
}

export function buildProductSnapshot(
  state: ProductState,
  generatedAt = new Date().toISOString(),
  verifiedProofs: Readonly<Record<string, string>> = {},
  durableEventIds: ReadonlySet<string> = new Set(),
): ProductSnapshot {
  const profile = state.profile
  const activeSelection = getActiveCompanionSelection(profile)
  const snapshot: ProductSnapshot = {
    schemaVersion: PRODUCT_SNAPSHOT_SCHEMA_VERSION,
    guestId: profile.guestId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    generatedAt,
    activeCompanionId: profile.activeCompanionId,
    activeSelection: { ...activeSelection },
    catalogVersion: profile.catalogVersion ?? COMPANION_CATALOG_VERSION,
    ...(profile.migrationVersion ? { migrationVersion: profile.migrationVersion } : {}),
    legacyCredits: state.legacyCredits.map((credit) => ({ ...credit })),
    companions: state.companions.map(snapshotCompanion),
    collection: profile.collection.map(snapshotCollectionReference),
    sourceBaselines: profile.sourceBaselines.map(snapshotBaseline),
    recoverabilityWarning: { ...profile.recoverabilityWarning },
    events: compactSnapshotEvents(state.ledger.events.map((event) => {
      const eventId = opaqueId(event.eventId, 'event')
      return productSnapshotEvent(event, verifiedProofs[eventId], true)
    }), durableEventIds),
    encounters: snapshotEncounters(state.encounters),
  }
  validateProductSnapshot(snapshot)
  return snapshot
}

function validateMetadata(value: unknown, field: string): asserts value is ProductEventMetadata {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  assertExactKeys(
    value,
    [],
    [
      'activityCount',
      'bucket',
      'number',
      'repositoryIdHash',
      'linkedPullRequestIdHash',
      'pullRequestIdHash',
      'sessionBucket',
    ],
    field,
  )
  for (const key of ['activityCount', 'bucket', 'number']) {
    if (key in value) assertFiniteNonNegative(value[key], `${field}.${key}`)
  }
  for (const key of ['repositoryIdHash', 'linkedPullRequestIdHash', 'pullRequestIdHash']) {
    if (key in value) assertNonEmptyString(value[key], `${field}.${key}`)
  }
  if ('sessionBucket' in value) {
    if (typeof value.sessionBucket !== 'string' || !/^\d{4}-\d{2}-\d{2}-\d+$/u.test(value.sessionBucket)) {
      throw new TypeError(`${field}.sessionBucket must be a derived session bucket`)
    }
  }
}

function validateEvent(value: unknown, index: number): asserts value is ProductSnapshotEvent {
  const field = `events[${index}]`
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  assertExactKeys(value, ['eventId', 'companionId', 'source', 'provenance', 'category', 'occurredAt'], ['verifiedProof', 'cap', 'metadata'], field)
  assertNonEmptyString(value.eventId, `${field}.eventId`)
  assertNonEmptyString(value.companionId, `${field}.companionId`)
  assertEnum(value.source, SOURCE_KINDS, `${field}.source`)
  assertEnum(value.provenance, PROVENANCES, `${field}.provenance`)
  assertEnum(value.category, EVENT_CATEGORIES, `${field}.category`)
  assertTimestamp(value.occurredAt, `${field}.occurredAt`)
  if ('verifiedProof' in value) {
    assertNonEmptyString(value.verifiedProof, `${field}.verifiedProof`)
    if (value.verifiedProof.length > 128) throw new TypeError(`${field}.verifiedProof is too long`)
  }
  if ('cap' in value) {
    if (!isRecord(value.cap)) throw new TypeError(`${field}.cap must be an object`)
    assertExactKeys(value.cap, ['key', 'limit'], [], `${field}.cap`)
    assertNonEmptyString(value.cap.key, `${field}.cap.key`)
    assertFiniteNonNegative(value.cap.limit, `${field}.cap.limit`)
    if (!Number.isInteger(value.cap.limit)) throw new TypeError(`${field}.cap.limit must be an integer`)
  }
  if ('metadata' in value) validateMetadata(value.metadata, `${field}.metadata`)
}

function validateCompanion(value: unknown, index: number): asserts value is ProductSnapshotCompanion {
  const field = `companions[${index}]`
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  assertExactKeys(value, ['companionId', 'familyId', 'xp', 'essence', 'encounterCount', 'progression'], [], field)
  assertNonEmptyString(value.companionId, `${field}.companionId`)
  if (value.familyId !== null) assertNonEmptyString(value.familyId, `${field}.familyId`)
  assertFiniteNonNegative(value.xp, `${field}.xp`)
  assertFiniteNonNegative(value.essence, `${field}.essence`)
  assertFiniteNonNegative(value.encounterCount, `${field}.encounterCount`)
  if (!Number.isInteger(value.encounterCount)) throw new TypeError(`${field}.encounterCount must be an integer`)
  if (value.progression !== null) {
    if (!isRecord(value.progression)) throw new TypeError(`${field}.progression must be an object or null`)
    assertExactKeys(value.progression, ['stepId', 'formId', 'nextStepId', 'nextFormId'], [], `${field}.progression`)
    assertNonEmptyString(value.progression.stepId, `${field}.progression.stepId`)
    assertNonEmptyString(value.progression.formId, `${field}.progression.formId`)
    if (value.progression.nextStepId !== null) assertNonEmptyString(value.progression.nextStepId, `${field}.progression.nextStepId`)
    if (value.progression.nextFormId !== null) assertNonEmptyString(value.progression.nextFormId, `${field}.progression.nextFormId`)
  }
}

function validateCollection(value: unknown, index: number): asserts value is ProductSnapshotCollectionReference {
  const field = `collection[${index}]`
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  assertExactKeys(value, ['referenceId', 'companionId', 'acquiredAt', 'acquisition'], [], field)
  assertNonEmptyString(value.referenceId, `${field}.referenceId`)
  assertNonEmptyString(value.companionId, `${field}.companionId`)
  assertTimestamp(value.acquiredAt, `${field}.acquiredAt`)
  assertEnum(value.acquisition, ['starter', 'history', 'encounter'], `${field}.acquisition`)
}

function validateBaseline(value: unknown, index: number): asserts value is ProductSnapshotSourceBaseline {
  const field = `sourceBaselines[${index}]`
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  assertExactKeys(value, ['sourceIdHash', 'kind', 'fingerprintHash', 'observedAt', 'metrics'], [], field)
  assertNonEmptyString(value.sourceIdHash, `${field}.sourceIdHash`)
  assertEnum(value.kind, ['notes', 'github'], `${field}.kind`)
  assertNonEmptyString(value.fingerprintHash, `${field}.fingerprintHash`)
  assertTimestamp(value.observedAt, `${field}.observedAt`)
  if (!isRecord(value.metrics)) throw new TypeError(`${field}.metrics must be an object`)
  for (const [key, metric] of Object.entries(value.metrics)) {
    if (!BASELINE_METRICS.has(key)) throw new TypeError(`${field}.metrics contains unsupported key`)
    assertFiniteNonNegative(metric, `${field}.metrics.${key}`)
  }
}

function validateWarning(value: unknown): asserts value is ProductSnapshotWarning {
  if (!isRecord(value)) throw new TypeError('recoverabilityWarning must be an object')
  assertExactKeys(value, ['status', 'lastShownAt', 'dismissedAt', 'updatedAt'], [], 'recoverabilityWarning')
  assertEnum(value.status, ['unseen', 'shown', 'dismissed'], 'recoverabilityWarning.status')
  if (value.lastShownAt !== null) assertTimestamp(value.lastShownAt, 'recoverabilityWarning.lastShownAt')
  if (value.dismissedAt !== null) assertTimestamp(value.dismissedAt, 'recoverabilityWarning.dismissedAt')
  assertTimestamp(value.updatedAt, 'recoverabilityWarning.updatedAt')
}

function validateWeight(value: unknown, field: string): asserts value is ProductSnapshotWeight {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  assertExactKeys(value, ['companionId', 'baseWeight', 'tagMatchCount', 'languageMatchCount', 'fileTypeMatchCount', 'tagBonus', 'languageBonus', 'fileTypeBonus', 'finalWeight'], [], field)
  assertNonEmptyString(value.companionId, `${field}.companionId`)
  for (const key of ['baseWeight', 'tagMatchCount', 'languageMatchCount', 'fileTypeMatchCount', 'tagBonus', 'languageBonus', 'fileTypeBonus', 'finalWeight']) {
    assertFiniteNonNegative(value[key], `${field}.${key}`)
  }
  for (const key of ['tagMatchCount', 'languageMatchCount', 'fileTypeMatchCount']) {
    if (!Number.isInteger(value[key])) throw new TypeError(`${field}.${key} must be an integer`)
  }
}

function validateDraw(value: unknown, index: number): asserts value is ProductSnapshotDraw {
  const field = `encounters.draws[${index}]`
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  assertExactKeys(value, ['id', 'sequence', 'triggerId', 'seed', 'selectedCompanionId', 'selectedFamilyId', 'isDuplicate', 'essenceAwarded', 'weights'], [], field)
  for (const key of ['id', 'triggerId', 'seed', 'selectedCompanionId', 'selectedFamilyId']) assertNonEmptyString(value[key], `${field}.${key}`)
  assertFiniteNonNegative(value.sequence, `${field}.sequence`)
  if (!Number.isInteger(value.sequence)) throw new TypeError(`${field}.sequence must be an integer`)
  if (value.sequence >= MAX_PRODUCT_DRAWS) throw new TypeError(`${field}.sequence is too large`)
  if (typeof value.isDuplicate !== 'boolean') throw new TypeError(`${field}.isDuplicate must be boolean`)
  assertFiniteNonNegative(value.essenceAwarded, `${field}.essenceAwarded`)
  if (value.essenceAwarded > MAX_ENCOUNTER_ESSENCE_PER_DRAW) {
    throw new TypeError(`${field}.essenceAwarded is too large`)
  }
  if (!Array.isArray(value.weights)) throw new TypeError(`${field}.weights must be an array`)
  if (value.weights.length > MAX_PRODUCT_DRAW_WEIGHTS) throw new TypeError(`${field}.weights is too large`)
  value.weights.forEach((weight, weightIndex) => validateWeight(weight, `${field}.weights[${weightIndex}]`))
}

function validateEncounters(value: unknown): asserts value is ProductSnapshotEncounters {
  if (!isRecord(value)) throw new TypeError('encounters must be an object')
  assertExactKeys(value, ['meter', 'totalProgress', 'nextSequence', 'draws', 'processedTriggerIds', 'essenceByFamily'], ['progressByTriggerId'], 'encounters')
  assertFiniteNonNegative(value.meter, 'encounters.meter')
  if (value.meter >= MAX_ENCOUNTER_METER) throw new TypeError('encounters.meter must be below the encounter threshold')
  assertFiniteNonNegative(value.totalProgress, 'encounters.totalProgress')
  if (value.totalProgress > MAX_ENCOUNTER_TOTAL_PROGRESS) throw new TypeError('encounters.totalProgress is too large')
  assertFiniteNonNegative(value.nextSequence, 'encounters.nextSequence')
  if (value.nextSequence > MAX_PRODUCT_DRAWS) throw new TypeError('encounters.nextSequence is too large')
  if (!Number.isInteger(value.nextSequence)) throw new TypeError('encounters.nextSequence must be an integer')
  if (!Array.isArray(value.draws)) throw new TypeError('encounters.draws must be an array')
  if (value.draws.length > MAX_PRODUCT_DRAWS) throw new TypeError('encounters.draws is too large')
  value.draws.forEach(validateDraw)
  if (!Array.isArray(value.processedTriggerIds) || !value.processedTriggerIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_PRODUCT_STRING_LENGTH)) {
    throw new TypeError('encounters.processedTriggerIds must be an array of strings')
  }
  if (value.processedTriggerIds.length > MAX_PRODUCT_TRIGGERS) throw new TypeError('encounters.processedTriggerIds is too large')
  if ('progressByTriggerId' in value) {
    if (!isRecord(value.progressByTriggerId)) throw new TypeError('encounters.progressByTriggerId must be an object')
    const progressEntries = Object.entries(value.progressByTriggerId)
    if (progressEntries.length > MAX_PRODUCT_TRIGGERS) throw new TypeError('encounters.progressByTriggerId is too large')
    for (const [triggerId, progress] of progressEntries) {
      assertNonEmptyString(triggerId, 'encounters.progressByTriggerId key')
      assertFiniteNonNegative(progress, `encounters.progressByTriggerId.${triggerId}`)
      if (progress > MAX_ENCOUNTER_TOTAL_PROGRESS) throw new TypeError(`encounters.progressByTriggerId.${triggerId} is too large`)
    }
  }
  if (!isRecord(value.essenceByFamily)) throw new TypeError('encounters.essenceByFamily must be an object')
  for (const [familyId, essence] of Object.entries(value.essenceByFamily)) {
    assertNonEmptyString(familyId, 'encounters.essenceByFamily key')
    assertFiniteNonNegative(essence, `encounters.essenceByFamily.${familyId}`)
    if (essence > MAX_ENCOUNTER_ESSENCE) {
      throw new TypeError(`encounters.essenceByFamily.${familyId} is too large`)
    }
  }
}

function validateActiveSelection(value: unknown): asserts value is ProductSnapshotActiveSelection {
  if (!isRecord(value)) throw new TypeError('activeSelection must be an object')
  assertExactKeys(
    value,
    ['companionId', 'provenance', 'selectedAt'],
    ['migrationVersion'],
    'activeSelection',
  )
  assertNonEmptyString(value.companionId, 'activeSelection.companionId')
  assertEnum(value.provenance, ['starter', 'user', 'migration'], 'activeSelection.provenance')
  assertTimestamp(value.selectedAt, 'activeSelection.selectedAt')
  if ('migrationVersion' in value) assertNonEmptyString(value.migrationVersion, 'activeSelection.migrationVersion')
}

function validateLegacyCredit(value: unknown, index: number): asserts value is ProductSnapshotLegacyCredit {
  const field = `legacyCredits[${index}]`
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`)
  assertExactKeys(value, ['creditId', 'migrationVersion', 'companionId', 'totalXp', 'sourceFingerprint'], [], field)
  assertNonEmptyString(value.creditId, `${field}.creditId`)
  assertNonEmptyString(value.migrationVersion, `${field}.migrationVersion`)
  assertNonEmptyString(value.companionId, `${field}.companionId`)
  assertFiniteNonNegative(value.totalXp, `${field}.totalXp`)
  assertNonEmptyString(value.sourceFingerprint, `${field}.sourceFingerprint`)
}

export function validateProductSnapshot(value: unknown): asserts value is ProductSnapshot {
  if (!isRecord(value)) throw new TypeError('Product snapshot must be an object')
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'guestId',
      'createdAt',
      'updatedAt',
      'generatedAt',
      'activeCompanionId',
      'activeSelection',
      'catalogVersion',
      'legacyCredits',
      'companions',
      'collection',
      'sourceBaselines',
      'recoverabilityWarning',
      'events',
      'encounters',
    ],
    ['migrationVersion'],
    'Product snapshot',
  )
  if (value.schemaVersion !== PRODUCT_SNAPSHOT_SCHEMA_VERSION) throw new TypeError('Unsupported product snapshot schema version')
  assertNonEmptyString(value.guestId, 'guestId')
  assertTimestamp(value.createdAt, 'createdAt')
  assertTimestamp(value.updatedAt, 'updatedAt')
  assertTimestamp(value.generatedAt, 'generatedAt')
  assertNonEmptyString(value.activeCompanionId, 'activeCompanionId')
  validateActiveSelection(value.activeSelection)
  assertNonEmptyString(value.catalogVersion, 'catalogVersion')
  if ('migrationVersion' in value) assertNonEmptyString(value.migrationVersion, 'migrationVersion')
  if (!Array.isArray(value.legacyCredits)) throw new TypeError('legacyCredits must be an array')
  if (value.legacyCredits.length > MAX_PRODUCT_CREDITS) throw new TypeError('legacyCredits is too large')
  value.legacyCredits.forEach(validateLegacyCredit)
  const creditIds = new Set<string>()
  for (const credit of value.legacyCredits) {
    if (creditIds.has(credit.creditId)) throw new TypeError('legacyCredits contains duplicate credit IDs')
    creditIds.add(credit.creditId)
  }
  if (!Array.isArray(value.companions)) throw new TypeError('companions must be an array')
  if (value.companions.length > MAX_PRODUCT_COMPANIONS) throw new TypeError('companions is too large')
  if (!Array.isArray(value.collection)) throw new TypeError('collection must be an array')
  if (value.collection.length > MAX_PRODUCT_COLLECTION_REFERENCES) throw new TypeError('collection is too large')
  if (!Array.isArray(value.sourceBaselines)) throw new TypeError('sourceBaselines must be an array')
  if (value.sourceBaselines.length > MAX_PRODUCT_BASELINES) throw new TypeError('sourceBaselines is too large')
  if (!Array.isArray(value.events)) throw new TypeError('events must be an array')
  if (value.events.length > MAX_PRODUCT_EVENTS) throw new TypeError('events is too large')
  value.companions.forEach(validateCompanion)
  value.collection.forEach(validateCollection)
  value.sourceBaselines.forEach(validateBaseline)
  value.events.forEach(validateEvent)
  validateWarning(value.recoverabilityWarning)
  validateEncounters(value.encounters)

  const companionIds = new Set(value.companions.map((companion) => companion.companionId))
  if (companionIds.size !== value.companions.length) {
    throw new TypeError('companions contains duplicate companion IDs')
  }
  const referenceIds = new Set<string>()
  for (const reference of value.collection) {
    if (referenceIds.has(reference.referenceId)) throw new TypeError('collection contains duplicate reference IDs')
    if (!companionIds.has(reference.companionId)) throw new TypeError('collection references an unknown companion')
    referenceIds.add(reference.referenceId)
  }
  const eventIds = new Set<string>()
  for (const event of value.events) {
    if (eventIds.has(event.eventId)) throw new TypeError('events contains duplicate event IDs')
    eventIds.add(event.eventId)
    if (!companionIds.has(event.companionId)) throw new TypeError('event references an unknown companion')
  }
  const baselineIds = new Set<string>()
  for (const baseline of value.sourceBaselines) {
    if (baselineIds.has(baseline.sourceIdHash)) throw new TypeError('sourceBaselines contains duplicate source IDs')
    baselineIds.add(baseline.sourceIdHash)
  }
  const drawIds = new Set<string>()
  const drawSequences = new Set<number>()
  for (const draw of value.encounters.draws) {
    if (drawIds.has(draw.id)) throw new TypeError('encounters.draws contains duplicate draw IDs')
    if (drawSequences.has(draw.sequence)) throw new TypeError('encounters.draws contains duplicate sequences')
    if (draw.sequence >= value.encounters.nextSequence) {
      throw new TypeError('encounters.draw sequence must be below nextSequence')
    }
    drawIds.add(draw.id)
    drawSequences.add(draw.sequence)
  }
  const processedTriggerIds = new Set(value.encounters.processedTriggerIds)
  if (processedTriggerIds.size !== value.encounters.processedTriggerIds.length) {
    throw new TypeError('encounters.processedTriggerIds contains duplicate IDs')
  }
}

const LEGACY_PRODUCT_SNAPSHOT_KEYS = [
  'schemaVersion',
  'guestId',
  'createdAt',
  'updatedAt',
  'generatedAt',
  'activeCompanionId',
  'companions',
  'collection',
  'sourceBaselines',
  'recoverabilityWarning',
  'events',
  'encounters',
] as const

/**
 * Convert the shipped v1 shape without trusting any of its derived totals.
 * The new fields are metadata/credits, so an old snapshot can be made
 * forward-compatible without inventing historical events or XP.
 */
export function upconvertProductSnapshot(value: unknown): ProductSnapshot {
  if (!isRecord(value)) throw new TypeError('Product snapshot must be an object')
  if (value.schemaVersion !== PRODUCT_SNAPSHOT_LEGACY_SCHEMA_VERSION) {
    throw new TypeError('Unsupported product snapshot schema version')
  }
  assertExactKeys(value, LEGACY_PRODUCT_SNAPSHOT_KEYS, [], 'Legacy product snapshot')
  const collection = Array.isArray(value.collection) ? value.collection : []
  const activeCompanionId = typeof value.activeCompanionId === 'string'
    ? value.activeCompanionId
    : ''
  const starterReference = collection.find((reference) => (
    isRecord(reference) &&
    reference.companionId === activeCompanionId &&
    reference.acquisition === 'starter'
  ))
  const selectedAt = isRecord(starterReference) && typeof starterReference.acquiredAt === 'string'
    ? starterReference.acquiredAt
    : typeof value.updatedAt === 'string'
      ? value.updatedAt
      : ''
  const upgraded = {
    ...value,
    schemaVersion: PRODUCT_SNAPSHOT_SCHEMA_VERSION,
    activeSelection: {
      companionId: activeCompanionId,
      provenance: starterReference ? 'starter' as const : 'user' as const,
      selectedAt,
    },
    catalogVersion: COMPANION_CATALOG_VERSION,
    legacyCredits: [],
  }
  validateProductSnapshot(upgraded)
  return upgraded
}

function normalizeProductSnapshot(value: unknown): ProductSnapshot {
  if (isRecord(value) && value.schemaVersion === PRODUCT_SNAPSHOT_LEGACY_SCHEMA_VERSION) {
    return upconvertProductSnapshot(value)
  }
  validateProductSnapshot(value)
  return value
}

export function serializeProductSnapshot(snapshot: ProductSnapshot): string {
  const normalized = normalizeProductSnapshot(snapshot)
  return JSON.stringify(normalized)
}

export function deserializeProductSnapshot(serialized: string | null): ProductSnapshot | null {
  if (serialized === null) return null
  try {
    return normalizeProductSnapshot(JSON.parse(serialized) as unknown)
  } catch {
    return null
  }
}

function unionById<T>(left: readonly T[], right: readonly T[], id: (value: T) => string): T[] {
  const result = new Map<string, T>()
  // The right-hand snapshot is the server copy. It is inserted first so a
  // conflicting replay keeps the server's canonical derived record while
  // still retaining IDs that only exist locally.
  for (const value of [...right, ...left]) if (!result.has(id(value))) result.set(id(value), value)
  return [...result.values()]
}

function hasHigherGithubActivityCount(
  event: ProductSnapshotEvent,
  existing: ProductSnapshotEvent,
): boolean {
  if (event.source !== 'github' || existing.source !== 'github') return false
  // The receipt binds the companion ID. Never let a replay delivered after a
  // companion switch move ownership of an already-awarded stable event.
  if (event.companionId !== existing.companionId) return false
  const activityCount = event.metadata?.activityCount
  const existingActivityCount = existing.metadata?.activityCount
  return typeof activityCount === 'number' &&
    typeof existingActivityCount === 'number' &&
    activityCount > existingActivityCount
}

function unionEvents(guest: readonly ProductSnapshotEvent[], server: readonly ProductSnapshotEvent[]): ProductSnapshotEvent[] {
  const result = new Map<string, ProductSnapshotEvent>()
  // The stored server event wins by default. A freshly receipt-backed event
  // may replace an older local copy with the same stable ID so a first
  // post-sync upload can upgrade an event without duplicating its XP. A later
  // receipt-backed GitHub aggregate may also refresh an older receipt-backed
  // server copy, but only when its activity count is higher.
  for (const event of [...server, ...guest]) {
    const existing = result.get(event.eventId)
    const receiptBacked = event.provenance === 'verified' && Boolean(event.verifiedProof)
    const existingReceiptBacked = existing?.provenance === 'verified' && Boolean(existing.verifiedProof)
    const refreshesGithubAggregate = existing !== undefined &&
      receiptBacked &&
      existingReceiptBacked &&
      hasHigherGithubActivityCount(event, existing)
    if (!existing || (receiptBacked && !existingReceiptBacked) || refreshesGithubAggregate) {
      result.set(event.eventId, event)
    }
  }
  return [...result.values()]
}

function snapshotCompanionIds(snapshot: ProductSnapshot): readonly string[] {
  return [
    snapshot.activeCompanionId,
    snapshot.activeSelection.companionId,
    ...snapshot.companions.map((companion) => companion.companionId),
    ...snapshot.collection.map((reference) => reference.companionId),
    ...snapshot.legacyCredits.map((credit) => credit.companionId),
    ...snapshot.events.map((event) => event.companionId),
    ...snapshot.encounters.draws.flatMap((draw) => [
      draw.selectedCompanionId,
      ...draw.weights.map((weight) => weight.companionId),
    ]),
  ]
}

/** Validate catalog identity and ownership at a sync/restore boundary. */
export function validateProductSnapshotForCatalog(
  snapshot: ProductSnapshot,
  catalog: CompanionCatalog,
): asserts snapshot is ProductSnapshot {
  validateProductSnapshot(snapshot)
  if (catalog.version !== undefined && snapshot.catalogVersion !== catalog.version) {
    throw new TypeError('Product snapshot catalog version is not supported')
  }
  if (snapshot.activeSelection.companionId !== snapshot.activeCompanionId) {
    throw new TypeError('activeSelection must match activeCompanionId')
  }
  const owned = new Set(snapshot.collection.map((reference) => reference.companionId))
  if (!owned.has(snapshot.activeCompanionId)) {
    throw new TypeError('activeCompanionId must be owned by the product snapshot')
  }
  const unknown = [...new Set(snapshotCompanionIds(snapshot))]
    .filter((companionId) => !catalog.get(companionId))
  if (unknown.length > 0) {
    throw new TypeError(`Product snapshot contains an unrecognized companion: ${unknown[0]}`)
  }
  const unownedReferencedCompanions = [
    ...snapshot.companions.map((companion) => companion.companionId),
    ...snapshot.events.map((event) => event.companionId),
    ...snapshot.legacyCredits.map((credit) => credit.companionId),
    ...snapshot.encounters.draws.map((draw) => draw.selectedCompanionId),
  ].filter((companionId) => !owned.has(companionId))
  if (unownedReferencedCompanions.length > 0) {
    throw new TypeError('Product snapshot references an unowned companion')
  }
  const catalogCompanionIds = new Set(catalog.list().map((definition) => definition.id))
  for (const draw of snapshot.encounters.draws) {
    const selected = catalog.get(draw.selectedCompanionId)
    if (!selected || selected.familyId !== draw.selectedFamilyId) {
      throw new TypeError('Encounter draw family does not match its companion')
    }
    const weightIds = new Set(draw.weights.map((weight) => weight.companionId))
    if (weightIds.size !== draw.weights.length || weightIds.size !== catalogCompanionIds.size || [...catalogCompanionIds].some((id) => !weightIds.has(id))) {
      throw new TypeError('Encounter draw weights do not match the companion catalog')
    }
    if ([...weightIds].some((id) => !catalogCompanionIds.has(id))) {
      throw new TypeError('Encounter draw references an unrecognized companion')
    }
  }
}

function migrationCreditForReference(
  reference: ProductSnapshotCollectionReference,
  credits: readonly ProductSnapshotLegacyCredit[],
): ProductSnapshotLegacyCredit | undefined {
  return credits.find((credit) => (
    credit.companionId === reference.companionId &&
    (reference.referenceId === credit.creditId || reference.referenceId === opaqueId(credit.creditId, 'ref'))
  ))
}

function canonicalSnapshotCollectionReference(
  reference: ProductSnapshotCollectionReference,
  credits: readonly ProductSnapshotLegacyCredit[],
): ProductSnapshotCollectionReference {
  const migrationCredit = migrationCreditForReference(reference, credits)
  return {
    ...reference,
    referenceId: migrationCredit
      ? opaqueId(migrationCredit.creditId, 'ref')
      : opaqueId(reference.referenceId, 'ref'),
  }
}

function restoredCollectionReference(
  reference: ProductSnapshotCollectionReference,
  credits: readonly ProductSnapshotLegacyCredit[],
): GuestCollectionReference {
  const migrationCredit = migrationCreditForReference(reference, credits)
  return {
    referenceId: migrationCredit?.creditId ?? reference.referenceId,
    companionId: reference.companionId,
    acquiredAt: reference.acquiredAt,
    acquisition: reference.acquisition,
  }
}

function toNormalizedEvent(event: ProductSnapshotEvent): NormalizedEvent {
  const metadata: Record<string, EventMetadataValue> = {}
  if (event.metadata?.activityCount !== undefined) metadata.activityCount = event.metadata.activityCount
  if (event.metadata?.bucket !== undefined) metadata.bucket = event.metadata.bucket
  if (event.metadata?.number !== undefined) metadata.number = event.metadata.number
  if (event.metadata?.sessionBucket !== undefined) metadata.sessionBucket = event.metadata.sessionBucket
  if (event.metadata?.repositoryIdHash !== undefined) metadata.repositoryIdHash = event.metadata.repositoryIdHash
  if (event.metadata?.linkedPullRequestIdHash !== undefined) {
    metadata.linkedPullRequestIdHash = event.metadata.linkedPullRequestIdHash
  }
  if (event.metadata?.pullRequestIdHash !== undefined) metadata.pullRequestIdHash = event.metadata.pullRequestIdHash
  return {
    eventId: asEventId(event.eventId),
    companionId: asCompanionId(event.companionId),
    source: event.source,
    sourceId: 'product-snapshot',
    provenance: event.provenance,
    category: event.category,
    occurredAt: event.occurredAt,
    ...(event.cap ? { cap: event.cap } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

/**
 * Rehydrate a browser runtime from a server snapshot.
 *
 * Snapshot fields intentionally contain hashes instead of local source IDs,
 * so restored baselines are not copied into the local source observer. The
 * event ledger and encounter history are still sufficient to rebuild XP,
 * collection, and progression without transferring note or repository text.
 */
export function restoreProductStateFromSnapshot(
  snapshot: ProductSnapshot,
  fallbackProfile: GuestProfile,
  catalog: CompanionCatalog,
): ProductState {
  const normalized = normalizeProductSnapshot(snapshot)
  validateProductSnapshotForCatalog(normalized, catalog)
  const profile: GuestProfile = {
    ...fallbackProfile,
    schemaVersion: 1,
    guestId: normalized.guestId,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    activeCompanionId: normalized.activeCompanionId,
    activeSelection: { ...normalized.activeSelection },
    catalogVersion: normalized.catalogVersion,
    migrationVersion: normalized.migrationVersion,
    legacyCredits: normalized.legacyCredits.map((credit) => ({ ...credit })),
    collection: normalized.collection.map((reference) => restoredCollectionReference(reference, normalized.legacyCredits)),
    recoverabilityWarning: { ...normalized.recoverabilityWarning },
  }
  const encounters: EncounterState = {
    meter: normalized.encounters.meter,
    totalProgress: normalized.encounters.totalProgress,
    nextSequence: normalized.encounters.nextSequence,
    draws: normalized.encounters.draws.map((draw): PersistedEncounterDraw => ({
      ...draw,
      weights: draw.weights.map((weight) => ({
        ...weight,
        matchedTags: [],
        matchedLanguages: [],
        matchedFileTypes: [],
      })),
    })),
    processedTriggerIds: [...normalized.encounters.processedTriggerIds],
    progressByTriggerId: { ...normalized.encounters.progressByTriggerId },
    essenceByFamily: { ...normalized.encounters.essenceByFamily },
  }
  return createProductState(
    profile,
    { events: normalized.events.map(toNormalizedEvent) },
    encounters,
    catalog,
  )
}

function safeXpTotal(eventXp: number, legacyXp: number): number {
  const total = eventXp + legacyXp
  return Number.isFinite(total) && total >= 0 ? total : Number.MAX_SAFE_INTEGER
}

function mergeCompanions(
  guest: readonly ProductSnapshotCompanion[],
  server: readonly ProductSnapshotCompanion[],
  eventLedger: EventLedger,
  collection: readonly ProductSnapshotCollectionReference[],
  encounters: ProductSnapshotEncounters,
  legacyCredits: readonly ProductSnapshotLegacyCredit[],
  catalog: CompanionCatalog = PROTOTYPE_COMPANION_CATALOG,
): ProductSnapshotCompanion[] {
  const byId = new Map<string, ProductSnapshotCompanion>()
  // Server is authoritative for non-replay fields. XP, progression, and
  // encounter counts are recomputed below from the unioned T1 inputs.
  for (const companion of [...server, ...guest]) {
    if (!byId.has(companion.companionId)) byId.set(companion.companionId, companion)
  }
  const eventXp = sumXpPerCompanion(eventLedger)
  const legacyXp = sumLegacyXpPerCompanion(legacyCredits)
  const counts = new Map<string, number>()
  for (const reference of collection) {
    counts.set(reference.companionId, (counts.get(reference.companionId) ?? 0) + 1)
  }
  const ids = new Set<string>([
    ...byId.keys(),
    ...collection.map((reference) => reference.companionId),
    ...eventLedger.events.map((event) => event.companionId),
    ...legacyCredits.map((credit) => credit.companionId),
  ])
  for (const companionId of ids) {
    const existing = byId.get(companionId)
    const definition = catalog.get(companionId)
    const xp = safeXpTotal(
      eventXp[companionId as keyof typeof eventXp] ?? 0,
      legacyXp[companionId] ?? 0,
    )
    const resolvedProgression = definition
      ? resolveCompanionProgression(definition, xp)
      : null
    byId.set(companionId, {
      companionId,
      familyId: definition?.familyId ?? existing?.familyId ?? null,
      xp,
      // Essence is derived from the trusted draw ledger, never from a client
      // aggregate that merely happened to pass shape validation.
      essence: definition ? encounters.essenceByFamily[definition.familyId] ?? 0 : 0,
      encounterCount: counts.get(companionId) ?? existing?.encounterCount ?? 0,
      progression: resolvedProgression
        ? {
            stepId: resolvedProgression.step.id,
            formId: resolvedProgression.form.id,
            nextStepId: resolvedProgression.nextStep?.id ?? null,
            nextFormId: resolvedProgression.nextForm?.id ?? null,
          }
        : existing?.progression ?? null,
    })
  }
  return [...byId.values()].sort((left, right) => left.companionId.localeCompare(right.companionId))
}

function mergeEncounters(guest: ProductSnapshotEncounters, server: ProductSnapshotEncounters): ProductSnapshotEncounters {
  const candidates = unionById(guest.draws, server.draws, (draw) => draw.id)
    .filter((draw) => draw.sequence < MAX_PRODUCT_DRAWS)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
  const usedSequences = new Set<number>()
  let nextSequence = Math.min(
    MAX_PRODUCT_DRAWS,
    Math.max(guest.nextSequence, server.nextSequence, ...candidates.map((draw) => draw.sequence + 1)),
  )
  const draws = candidates.map((draw) => {
    let sequence = draw.sequence
    if (usedSequences.has(sequence)) {
      sequence = nextSequence
      nextSequence = Math.min(MAX_PRODUCT_DRAWS, nextSequence + 1)
    } else {
      nextSequence = Math.max(nextSequence, sequence + 1)
    }
    usedSequences.add(sequence)
    return sequence === draw.sequence ? draw : { ...draw, sequence }
  })
  const processedTriggerIds = [...new Set([...guest.processedTriggerIds, ...server.processedTriggerIds])]
    .sort()
    .slice(0, MAX_PRODUCT_TRIGGERS)
  const progressByTriggerId: Record<string, number> = {}
  for (const [triggerId, progress] of Object.entries({
    ...(server.progressByTriggerId ?? {}),
    ...(guest.progressByTriggerId ?? {}),
  })) {
    if (!Number.isFinite(progress) || progress < 0) continue
    progressByTriggerId[triggerId] = Math.max(progressByTriggerId[triggerId] ?? 0, progress)
  }
  const boundedProgressEntries = Object.entries(progressByTriggerId).slice(0, MAX_PRODUCT_TRIGGERS)
  const boundedProgressByTriggerId = Object.fromEntries(boundedProgressEntries)
  const hasTriggerProgress = boundedProgressEntries.length > 0
  const legacyProgress = hasTriggerProgress
    ? Math.max(0, Math.max(guest.totalProgress, server.totalProgress) - progressTotal(boundedProgressByTriggerId))
    : Math.max(guest.totalProgress, server.totalProgress)
  const totalProgress = hasTriggerProgress
    ? legacyProgress + progressTotal(boundedProgressByTriggerId)
    : legacyProgress
  const essenceByFamily: Record<string, number> = {}
  // Recompute Essence from draw awards. The persisted aggregate is a cache,
  // not proof, and taking its max would let a forged value survive a merge.
  for (const draw of draws) {
    if (draw.essenceAwarded <= 0) continue
    const next = (essenceByFamily[draw.selectedFamilyId] ?? 0) + draw.essenceAwarded
    essenceByFamily[draw.selectedFamilyId] = Math.min(MAX_ENCOUNTER_ESSENCE, next)
  }
  return {
    meter: Math.min(MAX_ENCOUNTER_METER - 1, Math.max(guest.meter, server.meter)),
    totalProgress: Math.min(MAX_ENCOUNTER_TOTAL_PROGRESS, totalProgress),
    nextSequence,
    draws,
    processedTriggerIds,
    progressByTriggerId: boundedProgressByTriggerId,
    essenceByFamily,
  }
}

function referenceRank(reference: ProductSnapshotCollectionReference): number {
  return reference.acquisition === 'starter'
    ? 0
    : reference.acquisition === 'history'
      ? 1
      : 2
}

/** Explicit, stable fallback for old profiles that have no selection metadata. */
function deterministicOwnedReference(
  collection: readonly ProductSnapshotCollectionReference[],
): ProductSnapshotCollectionReference | undefined {
  return [...collection].sort((left, right) => (
    referenceRank(left) - referenceRank(right) ||
    left.acquiredAt.localeCompare(right.acquiredAt) ||
    left.referenceId.localeCompare(right.referenceId) ||
    left.companionId.localeCompare(right.companionId)
  ))[0]
}

function inferredSelection(
  snapshot: ProductSnapshot,
  collection: readonly ProductSnapshotCollectionReference[],
): ProductSnapshotActiveSelection | null {
  const owned = new Set(collection.map((reference) => reference.companionId))
  if (owned.has(snapshot.activeSelection.companionId)) {
    return { ...snapshot.activeSelection }
  }
  if (owned.has(snapshot.activeCompanionId)) {
    return {
      companionId: snapshot.activeCompanionId,
      provenance: 'user',
      selectedAt: snapshot.updatedAt,
    }
  }
  return null
}

function chooseActiveSelection(
  guest: ProductSnapshot,
  server: ProductSnapshot,
  collection: readonly ProductSnapshotCollectionReference[],
): ProductSnapshotActiveSelection {
  // The server row is the account authority. A client timestamp is replayable
  // input, so neither a higher provenance priority nor a future selectedAt may
  // replace a trusted server activation. The explicit activation endpoint is
  // the write path for changing this value.
  const serverSelection = inferredSelection(server, collection)
  if (serverSelection) return serverSelection

  const guestSelection = inferredSelection(guest, collection)
  if (guestSelection) return guestSelection

  const fallback = deterministicOwnedReference(collection)
  if (fallback) {
    return {
      companionId: fallback.companionId,
      provenance: fallback.acquisition === 'starter' ? 'starter' : 'user',
      selectedAt: fallback.acquiredAt,
    }
  }
  // A structurally valid snapshot may be empty while it is being recovered.
  // Keep the old active ID rather than deriving one from catalog order; the
  // catalog/ownership boundary rejects it before it can be trusted or synced.
  return {
    companionId: guest.activeCompanionId,
    provenance: 'user',
    selectedAt: guest.updatedAt,
  }
}

/** Merge a local guest snapshot with its server copy without double-counting IDs. */
export function mergeGuestWithServer(guest: ProductSnapshot, server: ProductSnapshot): ProductSnapshot {
  const guestSnapshot = normalizeProductSnapshot(guest)
  const serverSnapshot = normalizeProductSnapshot(server)
  if (guestSnapshot.guestId !== serverSnapshot.guestId) throw new TypeError('Cannot merge snapshots for different guests')

  const events = compactSnapshotEvents(unionEvents(guestSnapshot.events, serverSnapshot.events).sort(
    (left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId),
  ), new Set(serverSnapshot.events.map((event) => event.eventId)))
  const legacyCredits = unionById(guestSnapshot.legacyCredits, serverSnapshot.legacyCredits, (credit) => credit.creditId)
  const guestCollection = guestSnapshot.collection.map((reference) => canonicalSnapshotCollectionReference(reference, legacyCredits))
  const serverCollection = serverSnapshot.collection.map((reference) => canonicalSnapshotCollectionReference(reference, legacyCredits))
  const collection = unionById(guestCollection, serverCollection, (reference) => reference.referenceId).sort(
    (left, right) => left.acquiredAt.localeCompare(right.acquiredAt) || left.referenceId.localeCompare(right.referenceId),
  )
  const eventLedger: EventLedger = { events: events.map(toNormalizedEvent) }
  const encounters = mergeEncounters(guestSnapshot.encounters, serverSnapshot.encounters)
  const companions = mergeCompanions(
    guestSnapshot.companions,
    serverSnapshot.companions,
    eventLedger,
    collection,
    encounters,
    legacyCredits,
  )
  const activeSelection = chooseActiveSelection(guestSnapshot, serverSnapshot, collection)
  const sourceBaselines = unionById(guestSnapshot.sourceBaselines, serverSnapshot.sourceBaselines, (baseline) => baseline.sourceIdHash)
  const recoverabilityWarning = guestSnapshot.recoverabilityWarning.updatedAt >= serverSnapshot.recoverabilityWarning.updatedAt
    ? guestSnapshot.recoverabilityWarning
    : serverSnapshot.recoverabilityWarning
  const metadataSource = guestSnapshot.updatedAt >= serverSnapshot.updatedAt ? guestSnapshot : serverSnapshot
  const otherMetadataSource = metadataSource === guestSnapshot ? serverSnapshot : guestSnapshot
  const merged: ProductSnapshot = {
    schemaVersion: PRODUCT_SNAPSHOT_SCHEMA_VERSION,
    guestId: guestSnapshot.guestId,
    createdAt: guestSnapshot.createdAt <= serverSnapshot.createdAt ? guestSnapshot.createdAt : serverSnapshot.createdAt,
    updatedAt: guestSnapshot.updatedAt >= serverSnapshot.updatedAt ? guestSnapshot.updatedAt : serverSnapshot.updatedAt,
    generatedAt: guestSnapshot.generatedAt >= serverSnapshot.generatedAt ? guestSnapshot.generatedAt : serverSnapshot.generatedAt,
    activeCompanionId: activeSelection.companionId,
    activeSelection,
    catalogVersion: metadataSource.catalogVersion || otherMetadataSource.catalogVersion,
    ...(metadataSource.migrationVersion || otherMetadataSource.migrationVersion
      ? { migrationVersion: metadataSource.migrationVersion ?? otherMetadataSource.migrationVersion }
      : {}),
    legacyCredits,
    companions,
    collection,
    sourceBaselines,
    recoverabilityWarning,
    events,
    encounters,
  }
  validateProductSnapshot(merged)
  return merged
}

// Explicit aliases keep the adapter discoverable without breaking the names
// used by the first product-state implementation.
export const buildProductSyncedSnapshot = buildProductSnapshot
export const validateProductSyncedSnapshot = validateProductSnapshot
export const serializeProductSyncedSnapshot = serializeProductSnapshot
export const deserializeProductSyncedSnapshot = deserializeProductSnapshot
export const mergeProductSnapshots = mergeGuestWithServer
export const mergeSyncedSnapshots = mergeGuestWithServer
