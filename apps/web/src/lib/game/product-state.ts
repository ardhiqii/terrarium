/**
 * Product-level state composition for the new companion loop.
 *
 * This is deliberately separate from the legacy `CreatureState`. It joins the
 * guest profile, normalized event ledger, encounter state, and provider-neutral
 * catalog without making any of those layers depend on React, GitHub, or the
 * browser.
 */
import {
  addEvents,
  asCompanionId,
  sumXpPerCompanion,
  type EventLedger,
  type NormalizedEvent,
} from './events'
import {
  advanceEncounter,
  createEncounterState,
  type EncounterSignals,
  type EncounterState,
} from './encounters'
import { resolveCompanionProgression, type CompanionCatalog } from './companion-catalog'
import {
  dedupeLegacyXpCredits,
  sumLegacyXpPerCompanion,
  type GuestCollectionReference,
  type GuestProfile,
  type LegacyXpCredit,
} from './guest-profile'
import { canonicalizeProductEvent } from '../sync/product-event-id'

export interface ProductCompanionState {
  companionId: string
  familyId: string | null
  xp: number
  essence: number
  encounterCount: number
  progression: ReturnType<typeof resolveCompanionProgression> | null
}

export interface ProductState {
  profile: GuestProfile
  ledger: EventLedger
  encounters: EncounterState
  /** Deduplicated, persisted aggregate grants exposed for snapshot adapters. */
  legacyCredits: readonly LegacyXpCredit[]
  companions: readonly ProductCompanionState[]
  activeCompanion: ProductCompanionState | null
}

export interface CreateProductStateOptions {
  /** Optional restored credits supplied by a snapshot adapter during T2. */
  legacyCredits?: readonly LegacyXpCredit[]
}

export interface ApplyProductEventsOptions {
  /** Signals from the newly observed source activity, used for encounter weighting. */
  encounterSignals?: EncounterSignals
  /** Stable source scan/webhook ID. Defaults to the sorted event IDs. */
  triggerId?: string
  /** Stable seed. Defaults to the sorted event IDs. */
  seed?: string
  /** Activity units added to the hidden encounter meter. Defaults to new event count. */
  encounterProgress?: number
}

function sortedIds(events: readonly NormalizedEvent[]): string {
  return events.map((event) => event.eventId).sort().join('|')
}

function safeXpSum(left: number, right: number): number {
  const total = left + right
  return Number.isFinite(total) && total >= 0 ? total : Number.MAX_SAFE_INTEGER
}

interface MergedProductEvents {
  ledger: EventLedger
  newEvents: readonly NormalizedEvent[]
}

/**
 * Merge source deliveries by stable ID while allowing verified evidence to
 * replace an older record. A replacement is ledger-only: it is not a new
 * activity event and must not drive XP or encounter progression a second time.
 */
function ledgerEvent(event: NormalizedEvent): NormalizedEvent {
  // Canonicalize cap buckets for restored snapshots, but retain the source
  // event ID already stored in the ledger. Migration and retry semantics treat
  // that durable ID as ownership evidence and must not rewrite it merely
  // because a replay passed through the snapshot adapter.
  const canonical = canonicalizeProductEvent(event)
  return canonical.eventId === event.eventId
    ? canonical
    : { ...canonical, eventId: event.eventId }
}

function eventKey(event: NormalizedEvent): string {
  return String(canonicalizeProductEvent(event).eventId)
}

function equivalentLedgerEvent(left: NormalizedEvent, right: NormalizedEvent): boolean {
  const normalizedLeft = ledgerEvent(left)
  const normalizedRight = ledgerEvent(right)
  return JSON.stringify({ ...normalizedLeft, eventId: eventKey(left) }) ===
    JSON.stringify({ ...normalizedRight, eventId: eventKey(right) })
}

/**
 * Bind fresh local source events to the active companion at capture time.
 * Existing IDs are left untouched so replay cannot move historical ownership;
 * verified provider events are also left untouched because a receipt may bind
 * their original companion ID.
 */
export function captureProductEventsForActiveCompanion(
  state: ProductState,
  incoming: readonly NormalizedEvent[],
): readonly NormalizedEvent[] {
  const activeCompanionId = state.profile.activeCompanionId
  if (!state.profile.collection.some((reference) => reference.companionId === activeCompanionId)) {
    return incoming
  }
  const existingIds = new Set(state.ledger.events.map(eventKey))
  return incoming.map((event) => {
    if (event.provenance !== 'local' || existingIds.has(eventKey(event)) || event.companionId === activeCompanionId) {
      return event
    }
    return { ...event, companionId: asCompanionId(activeCompanionId) }
  })
}

function mergeProductEvents(
  ledger: EventLedger,
  incoming: readonly NormalizedEvent[],
): MergedProductEvents {
  const eventsById = new Map<string, NormalizedEvent>()
  for (const event of ledger.events) {
    const stored = ledgerEvent(event)
    const key = eventKey(event)
    // Keep the ledger's existing first-write rule even if a caller supplies a
    // hand-built ledger instead of one produced by addEvents.
    if (!eventsById.has(key)) eventsById.set(key, stored)
  }
  const newEvents: NormalizedEvent[] = []
  const newEventIndexes = new Map<string, number>()
  let replacedExisting = false

  for (const rawEvent of incoming) {
    const event = ledgerEvent(rawEvent)
    const key = eventKey(rawEvent)
    const existing = eventsById.get(key)
    if (!existing) {
      newEventIndexes.set(key, newEvents.length)
      newEvents.push(event)
      eventsById.set(key, event)
      continue
    }

    // Verified evidence is authoritative for an existing stable ID. A local
    // replay can never replace a verified record, while a later verified
    // delivery refreshes the newest metadata/cap/provenance in the ledger.
    // Keep the original companion owner when a provider scan arrives after the
    // user switched active companions: the receipt route preserves that owner
    // too, and accepting a differently-bound receipt here would move old XP.
    if (event.provenance === 'verified' && (
      existing.provenance !== 'verified' || event.companionId === existing.companionId
    ) && !equivalentLedgerEvent(existing, event)) {
      const replacement = { ...event, eventId: existing.eventId }
      replacedExisting = true
      eventsById.set(key, replacement)
      const newEventIndex = newEventIndexes.get(key)
      if (newEventIndex !== undefined) newEvents[newEventIndex] = replacement
    }
  }

  return {
    // A duplicate-only replay must preserve the original event bytes exactly;
    // a fresh event or verified refresh gets the canonical cap-key validation.
    ledger: newEvents.length === 0 && !replacedExisting
      ? ledger
      : addEvents({ events: [] }, [...eventsById.values()]),
    newEvents,
  }
}

function referencesByCompanion(
  references: readonly GuestCollectionReference[],
): Map<string, GuestCollectionReference[]> {
  const result = new Map<string, GuestCollectionReference[]>()
  for (const reference of references) {
    const current = result.get(reference.companionId) ?? []
    current.push(reference)
    result.set(reference.companionId, current)
  }
  return result
}

function companionIds(
  profile: GuestProfile,
  ledger: EventLedger,
  legacyCredits: readonly LegacyXpCredit[],
): string[] {
  // Keep the profile's acquisition order for backwards-compatible snapshots
  // and stable active-first presentation. Event/credit-only identities follow
  // deterministically by their first appearance rather than catalog order.
  const ids = new Set<string>()
  for (const reference of profile.collection) ids.add(reference.companionId)
  for (const event of ledger.events) ids.add(event.companionId)
  for (const credit of legacyCredits) ids.add(credit.companionId)
  return [...ids]
}

export function createProductState(
  profile: GuestProfile,
  ledger: EventLedger = { events: [] },
  encounters: EncounterState | undefined = createEncounterState(),
  catalog: CompanionCatalog,
  options: CreateProductStateOptions = {},
): ProductState {
  const resolvedEncounters = encounters ?? createEncounterState()
  const legacyCredits = dedupeLegacyXpCredits([
    ...(profile.legacyCredits ?? []),
    ...(options.legacyCredits ?? []),
  ])
  // T2 may supply credits while restoring an older profile shape. Keep the
  // resulting ProductState self-contained so a caller can persist profile and
  // derived state together without turning a credit into a fake event.
  const needsCreditPersistence = profile.legacyCredits === undefined ||
    (options.legacyCredits !== undefined && JSON.stringify(profile.legacyCredits) !== JSON.stringify(legacyCredits))
  const resolvedProfile = needsCreditPersistence
    ? { ...profile, legacyCredits }
    : profile
  const eventTotals = sumXpPerCompanion(ledger)
  const creditTotals = sumLegacyXpPerCompanion(legacyCredits)
  const references = referencesByCompanion(resolvedProfile.collection)
  const companions = companionIds(resolvedProfile, ledger, legacyCredits).map((companionId) => {
    const definition = catalog.get(companionId)
    const eventXp = eventTotals[companionId as keyof typeof eventTotals] ?? 0
    const legacyXp = creditTotals[companionId] ?? 0
    const xp = safeXpSum(eventXp, legacyXp)
    return {
      companionId,
      familyId: definition?.familyId ?? null,
      xp,
      essence: definition ? resolvedEncounters.essenceByFamily[definition.familyId] ?? 0 : 0,
      encounterCount: references.get(companionId)?.length ?? 0,
      progression: definition ? resolveCompanionProgression(definition, xp) : null,
    }
  })
  const activeIsOwned = resolvedProfile.collection.some(
    (reference) => reference.companionId === resolvedProfile.activeCompanionId,
  )

  return {
    profile: resolvedProfile,
    ledger,
    encounters: resolvedEncounters,
    legacyCredits,
    companions,
    activeCompanion: activeIsOwned
      ? companions.find((companion) => companion.companionId === resolvedProfile.activeCompanionId) ?? null
      : null,
  }
}

/**
 * Apply only new events, then advance the encounter meter once for that batch.
 * Replaying the same batch is safe because the event ledger and trigger ID are
 * both idempotent.
 */
export function applyProductEvents(
  state: ProductState,
  incoming: readonly NormalizedEvent[],
  catalog: CompanionCatalog,
  options: ApplyProductEventsOptions = {},
): ProductState {
  const capturedIncoming = captureProductEventsForActiveCompanion(state, incoming)
  const { ledger, newEvents } = mergeProductEvents(state.ledger, capturedIncoming)
  if (newEvents.length === 0) return createProductState(state.profile, ledger, state.encounters, catalog)

  const token = sortedIds(newEvents)
  const triggerId = options.triggerId ?? `activity:${token}`
  const seed = options.seed ?? token
  const encounterResult = advanceEncounter(
    state.encounters,
    {
      id: triggerId,
      progress: options.encounterProgress ?? newEvents.length,
      seed,
      signals: options.encounterSignals ?? {},
      ownedCompanionIds: state.profile.collection.map((reference) => reference.companionId),
    },
    catalog,
  )

  const newReferences: GuestCollectionReference[] = encounterResult.newDraws.map((draw) => ({
    referenceId: draw.id,
    companionId: draw.selectedCompanionId,
    acquiredAt: new Date().toISOString(),
    acquisition: 'encounter',
  }))
  const profile = newReferences.length
    ? {
        ...state.profile,
        updatedAt: new Date().toISOString(),
        collection: [...state.profile.collection, ...newReferences],
      }
    : state.profile

  return createProductState(profile, ledger, encounterResult.state, catalog)
}

export function switchActiveCompanion(
  state: ProductState,
  companionId: string,
  catalog: CompanionCatalog,
  now = new Date().toISOString(),
): ProductState {
  if (!state.profile.collection.some((reference) => reference.companionId === companionId)) {
    return state
  }
  const profile = {
    ...state.profile,
    activeCompanionId: companionId,
    activeSelection: {
      companionId,
      provenance: 'user' as const,
      selectedAt: now,
    },
    updatedAt: now,
  }
  return createProductState(profile, state.ledger, state.encounters, catalog)
}
