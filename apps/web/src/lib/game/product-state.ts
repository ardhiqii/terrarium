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
import type { GuestCollectionReference, GuestProfile } from './guest-profile'
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
  companions: readonly ProductCompanionState[]
  activeCompanion: ProductCompanionState | null
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

interface MergedProductEvents {
  ledger: EventLedger
  newEvents: readonly NormalizedEvent[]
}

/**
 * Merge source deliveries by stable ID while allowing verified evidence to
 * replace an older record. A replacement is ledger-only: it is not a new
 * activity event and must not drive XP or encounter progression a second time.
 */
function mergeProductEvents(
  ledger: EventLedger,
  incoming: readonly NormalizedEvent[],
): MergedProductEvents {
  const eventsById = new Map<string, NormalizedEvent>()
  for (const event of ledger.events) {
    // Canonicalize restored/legacy records too. Otherwise a raw provider cap
    // key can coexist with its opaque snapshot form and bypass one shared cap
    // bucket after a browser reload.
    const canonical = canonicalizeProductEvent(event)
    // Keep the ledger's existing first-write rule even if a caller supplies a
    // hand-built ledger instead of one produced by addEvents.
    if (!eventsById.has(canonical.eventId)) eventsById.set(canonical.eventId, canonical)
  }
  const newEvents: NormalizedEvent[] = []
  const newEventIndexes = new Map<string, number>()

  for (const event of incoming) {
    const existing = eventsById.get(event.eventId)
    if (!existing) {
      newEventIndexes.set(event.eventId, newEvents.length)
      newEvents.push(event)
      eventsById.set(event.eventId, event)
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
    )) {
      eventsById.set(event.eventId, event)
      const newEventIndex = newEventIndexes.get(event.eventId)
      if (newEventIndex !== undefined) newEvents[newEventIndex] = event
    }
  }

  return {
    // Re-run the normal ledger validation/deduplication on the merged records.
    ledger: addEvents({ events: [] }, [...eventsById.values()]),
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

function companionIds(profile: GuestProfile, ledger: EventLedger): string[] {
  const ids = new Set(profile.collection.map((reference) => reference.companionId))
  for (const event of ledger.events) ids.add(event.companionId)
  return [...ids].sort()
}

export function createProductState(
  profile: GuestProfile,
  ledger: EventLedger = { events: [] },
  encounters: EncounterState | undefined = createEncounterState(),
  catalog: CompanionCatalog,
): ProductState {
  const resolvedEncounters = encounters ?? createEncounterState()
  const totals = sumXpPerCompanion(ledger)
  const references = referencesByCompanion(profile.collection)
  const companions = companionIds(profile, ledger).map((companionId) => {
    const definition = catalog.get(companionId)
    const xp = totals[companionId as keyof typeof totals] ?? 0
    return {
      companionId,
      familyId: definition?.familyId ?? null,
      xp,
      essence: definition ? resolvedEncounters.essenceByFamily[definition.familyId] ?? 0 : 0,
      encounterCount: references.get(companionId)?.length ?? 0,
      progression: definition ? resolveCompanionProgression(definition, xp) : null,
    }
  })

  return {
    profile,
    ledger,
    encounters: resolvedEncounters,
    companions,
    activeCompanion:
      companions.find((companion) => companion.companionId === profile.activeCompanionId) ?? null,
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
  const canonicalIncoming = incoming.map(canonicalizeProductEvent)
  const { ledger, newEvents } = mergeProductEvents(state.ledger, canonicalIncoming)
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
): ProductState {
  if (!state.profile.collection.some((reference) => reference.companionId === companionId)) {
    return state
  }
  const profile = {
    ...state.profile,
    activeCompanionId: companionId,
    updatedAt: new Date().toISOString(),
  }
  return createProductState(profile, state.ledger, state.encounters, catalog)
}
