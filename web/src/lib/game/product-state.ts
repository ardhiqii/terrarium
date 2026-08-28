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
  const known = new Set(state.ledger.events.map((event) => event.eventId))
  const newEvents = incoming.filter((event) => !known.has(event.eventId))
  const ledger = addEvents(state.ledger, newEvents)
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
