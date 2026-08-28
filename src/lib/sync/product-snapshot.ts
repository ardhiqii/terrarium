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
import type {
  EncounterState,
  PersistedEncounterDraw,
} from '../game/encounters'
import type {
  GuestCollectionReference,
  GuestProfile,
  LocalSourceBaseline,
} from '../game/guest-profile'
import type { ProductCompanionState, ProductState } from '../game/product-state'

export const PRODUCT_SNAPSHOT_SCHEMA_VERSION = 1
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
  readonly essenceByFamily: Readonly<Record<string, number>>
}

export interface ProductSnapshot {
  readonly schemaVersion: number
  readonly guestId: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly generatedAt: string
  readonly activeCompanionId: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
}

function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`)
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

/** A deterministic opaque ID suitable for sync while remaining stable across devices. */
function opaqueId(value: string, prefix: string): string {
  let first = 2166136261
  let second = 2246822519
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ (code + index), 3266489917)
  }
  return `${prefix}-${(first >>> 0).toString(16).padStart(8, '0')}-${(second >>> 0).toString(16).padStart(8, '0')}`
}

function safeMetadata(metadata: Readonly<Record<string, EventMetadataValue>> | undefined): ProductEventMetadata | undefined {
  if (!metadata) return undefined
  const result = {} as { -readonly [K in keyof ProductEventMetadata]?: ProductEventMetadata[K] }
  if (typeof metadata.activityCount === 'number') result.activityCount = metadata.activityCount
  if (typeof metadata.bucket === 'number') result.bucket = metadata.bucket
  if (typeof metadata.number === 'number') result.number = metadata.number
  if (typeof metadata.repositoryId === 'string') result.repositoryIdHash = opaqueId(metadata.repositoryId, 'repo')
  if (typeof metadata.linkedPullRequestId === 'string') {
    result.linkedPullRequestIdHash = opaqueId(metadata.linkedPullRequestId, 'pr')
  }
  if (typeof metadata.pullRequestId === 'string') {
    result.pullRequestIdHash = opaqueId(metadata.pullRequestId, 'pr')
  }
  if (typeof metadata.sessionBucket === 'string' && /^\d{4}-\d{2}-\d{2}-\d+$/u.test(metadata.sessionBucket)) {
    result.sessionBucket = metadata.sessionBucket
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function snapshotEvent(event: NormalizedEvent): ProductSnapshotEvent {
  return {
    eventId: opaqueId(event.eventId, 'event'),
    companionId: event.companionId,
    source: event.source,
    provenance: event.provenance,
    category: event.category,
    occurredAt: event.occurredAt,
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
  return {
    meter: encounters.meter,
    totalProgress: encounters.totalProgress,
    nextSequence: encounters.nextSequence,
    draws: encounters.draws.map(snapshotDraw),
    processedTriggerIds: encounters.processedTriggerIds.map((id) => opaqueId(id, 'trigger')),
    essenceByFamily: { ...encounters.essenceByFamily },
  }
}

export function buildProductSnapshot(
  state: ProductState,
  generatedAt = new Date().toISOString(),
): ProductSnapshot {
  const profile = state.profile
  const snapshot: ProductSnapshot = {
    schemaVersion: PRODUCT_SNAPSHOT_SCHEMA_VERSION,
    guestId: profile.guestId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    generatedAt,
    activeCompanionId: profile.activeCompanionId,
    companions: state.companions.map(snapshotCompanion),
    collection: profile.collection.map(snapshotCollectionReference),
    sourceBaselines: profile.sourceBaselines.map(snapshotBaseline),
    recoverabilityWarning: { ...profile.recoverabilityWarning },
    events: state.ledger.events.map(snapshotEvent),
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
  assertExactKeys(value, ['eventId', 'companionId', 'source', 'provenance', 'category', 'occurredAt'], ['cap', 'metadata'], field)
  assertNonEmptyString(value.eventId, `${field}.eventId`)
  assertNonEmptyString(value.companionId, `${field}.companionId`)
  assertEnum(value.source, SOURCE_KINDS, `${field}.source`)
  assertEnum(value.provenance, PROVENANCES, `${field}.provenance`)
  assertEnum(value.category, EVENT_CATEGORIES, `${field}.category`)
  assertTimestamp(value.occurredAt, `${field}.occurredAt`)
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
  if (typeof value.isDuplicate !== 'boolean') throw new TypeError(`${field}.isDuplicate must be boolean`)
  assertFiniteNonNegative(value.essenceAwarded, `${field}.essenceAwarded`)
  if (!Array.isArray(value.weights)) throw new TypeError(`${field}.weights must be an array`)
  value.weights.forEach((weight, weightIndex) => validateWeight(weight, `${field}.weights[${weightIndex}]`))
}

function validateEncounters(value: unknown): asserts value is ProductSnapshotEncounters {
  if (!isRecord(value)) throw new TypeError('encounters must be an object')
  assertExactKeys(value, ['meter', 'totalProgress', 'nextSequence', 'draws', 'processedTriggerIds', 'essenceByFamily'], [], 'encounters')
  assertFiniteNonNegative(value.meter, 'encounters.meter')
  assertFiniteNonNegative(value.totalProgress, 'encounters.totalProgress')
  assertFiniteNonNegative(value.nextSequence, 'encounters.nextSequence')
  if (!Number.isInteger(value.nextSequence)) throw new TypeError('encounters.nextSequence must be an integer')
  if (!Array.isArray(value.draws)) throw new TypeError('encounters.draws must be an array')
  value.draws.forEach(validateDraw)
  if (!Array.isArray(value.processedTriggerIds) || !value.processedTriggerIds.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new TypeError('encounters.processedTriggerIds must be an array of strings')
  }
  if (!isRecord(value.essenceByFamily)) throw new TypeError('encounters.essenceByFamily must be an object')
  for (const [familyId, essence] of Object.entries(value.essenceByFamily)) {
    assertNonEmptyString(familyId, 'encounters.essenceByFamily key')
    assertFiniteNonNegative(essence, `encounters.essenceByFamily.${familyId}`)
  }
}

export function validateProductSnapshot(value: unknown): asserts value is ProductSnapshot {
  if (!isRecord(value)) throw new TypeError('Product snapshot must be an object')
  assertExactKeys(
    value,
    ['schemaVersion', 'guestId', 'createdAt', 'updatedAt', 'generatedAt', 'activeCompanionId', 'companions', 'collection', 'sourceBaselines', 'recoverabilityWarning', 'events', 'encounters'],
    [],
    'Product snapshot',
  )
  if (value.schemaVersion !== PRODUCT_SNAPSHOT_SCHEMA_VERSION) throw new TypeError('Unsupported product snapshot schema version')
  assertNonEmptyString(value.guestId, 'guestId')
  assertTimestamp(value.createdAt, 'createdAt')
  assertTimestamp(value.updatedAt, 'updatedAt')
  assertTimestamp(value.generatedAt, 'generatedAt')
  assertNonEmptyString(value.activeCompanionId, 'activeCompanionId')
  if (!Array.isArray(value.companions)) throw new TypeError('companions must be an array')
  if (!Array.isArray(value.collection)) throw new TypeError('collection must be an array')
  if (!Array.isArray(value.sourceBaselines)) throw new TypeError('sourceBaselines must be an array')
  if (!Array.isArray(value.events)) throw new TypeError('events must be an array')
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
  for (const draw of value.encounters.draws) {
    if (drawIds.has(draw.id)) throw new TypeError('encounters.draws contains duplicate draw IDs')
    drawIds.add(draw.id)
  }
  const processedTriggerIds = new Set(value.encounters.processedTriggerIds)
  if (processedTriggerIds.size !== value.encounters.processedTriggerIds.length) {
    throw new TypeError('encounters.processedTriggerIds contains duplicate IDs')
  }
}

export function serializeProductSnapshot(snapshot: ProductSnapshot): string {
  validateProductSnapshot(snapshot)
  return JSON.stringify(snapshot)
}

export function deserializeProductSnapshot(serialized: string | null): ProductSnapshot | null {
  if (serialized === null) return null
  try {
    const value: unknown = JSON.parse(serialized)
    validateProductSnapshot(value)
    return value
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

function toNormalizedEvent(event: ProductSnapshotEvent): NormalizedEvent {
  const metadata: Record<string, EventMetadataValue> = {}
  if (event.metadata?.activityCount !== undefined) metadata.activityCount = event.metadata.activityCount
  if (event.metadata?.bucket !== undefined) metadata.bucket = event.metadata.bucket
  if (event.metadata?.number !== undefined) metadata.number = event.metadata.number
  if (event.metadata?.sessionBucket !== undefined) metadata.sessionBucket = event.metadata.sessionBucket
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

function mergeCompanions(
  guest: readonly ProductSnapshotCompanion[],
  server: readonly ProductSnapshotCompanion[],
  eventLedger: EventLedger,
  collection: readonly ProductSnapshotCollectionReference[],
): ProductSnapshotCompanion[] {
  const byId = new Map<string, ProductSnapshotCompanion>()
  // Server is authoritative for non-replay fields. XP and encounter counts
  // are recomputed below from the unioned derived ledger/collection.
  for (const companion of [...server, ...guest]) {
    if (!byId.has(companion.companionId)) byId.set(companion.companionId, companion)
  }
  const xp = sumXpPerCompanion(eventLedger)
  const counts = new Map<string, number>()
  for (const reference of collection) counts.set(reference.companionId, (counts.get(reference.companionId) ?? 0) + 1)
  for (const [companionId, total] of Object.entries(xp)) {
    const existing = byId.get(companionId)
    if (existing) byId.set(companionId, { ...existing, xp: total, encounterCount: counts.get(companionId) ?? existing.encounterCount })
  }
  return [...byId.values()].sort((left, right) => left.companionId.localeCompare(right.companionId))
}

function mergeEncounters(guest: ProductSnapshotEncounters, server: ProductSnapshotEncounters): ProductSnapshotEncounters {
  const draws = unionById(guest.draws, server.draws, (draw) => draw.id).sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
  const processedTriggerIds = [...new Set([...guest.processedTriggerIds, ...server.processedTriggerIds])].sort()
  const essenceByFamily: Record<string, number> = {}
  for (const source of [guest.essenceByFamily, server.essenceByFamily]) {
    for (const [familyId, amount] of Object.entries(source)) essenceByFamily[familyId] = Math.max(essenceByFamily[familyId] ?? 0, amount)
  }
  for (const draw of draws) {
    essenceByFamily[draw.selectedFamilyId] = Math.max(
      essenceByFamily[draw.selectedFamilyId] ?? 0,
      draws.filter((candidate) => candidate.selectedFamilyId === draw.selectedFamilyId).reduce((sum, candidate) => sum + candidate.essenceAwarded, 0),
    )
  }
  return {
    meter: Math.max(guest.meter, server.meter),
    totalProgress: Math.max(guest.totalProgress, server.totalProgress),
    nextSequence: Math.max(guest.nextSequence, server.nextSequence, ...draws.map((draw) => draw.sequence + 1)),
    draws,
    processedTriggerIds,
    essenceByFamily,
  }
}

/** Merge a local guest snapshot with its server copy without double-counting IDs. */
export function mergeGuestWithServer(guest: ProductSnapshot, server: ProductSnapshot): ProductSnapshot {
  validateProductSnapshot(guest)
  validateProductSnapshot(server)
  if (guest.guestId !== server.guestId) throw new TypeError('Cannot merge snapshots for different guests')

  const events = unionById(guest.events, server.events, (event) => event.eventId).sort(
    (left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId),
  )
  const collection = unionById(guest.collection, server.collection, (reference) => reference.referenceId).sort(
    (left, right) => left.acquiredAt.localeCompare(right.acquiredAt) || left.referenceId.localeCompare(right.referenceId),
  )
  const eventLedger: EventLedger = { events: events.map(toNormalizedEvent) }
  const companions = mergeCompanions(guest.companions, server.companions, eventLedger, collection)
  const validCompanion = (id: string) => collection.some((reference) => reference.companionId === id)
  const activeCompanionId = validCompanion(guest.activeCompanionId)
    ? guest.activeCompanionId
    : validCompanion(server.activeCompanionId)
      ? server.activeCompanionId
      : collection[0]?.companionId ?? guest.activeCompanionId
  const sourceBaselines = unionById(guest.sourceBaselines, server.sourceBaselines, (baseline) => baseline.sourceIdHash)
  const recoverabilityWarning = guest.recoverabilityWarning.updatedAt >= server.recoverabilityWarning.updatedAt
    ? guest.recoverabilityWarning
    : server.recoverabilityWarning
  const merged: ProductSnapshot = {
    schemaVersion: PRODUCT_SNAPSHOT_SCHEMA_VERSION,
    guestId: guest.guestId,
    createdAt: guest.createdAt <= server.createdAt ? guest.createdAt : server.createdAt,
    updatedAt: guest.updatedAt >= server.updatedAt ? guest.updatedAt : server.updatedAt,
    generatedAt: guest.generatedAt >= server.generatedAt ? guest.generatedAt : server.generatedAt,
    activeCompanionId,
    companions,
    collection,
    sourceBaselines,
    recoverabilityWarning,
    events,
    encounters: mergeEncounters(guest.encounters, server.encounters),
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
