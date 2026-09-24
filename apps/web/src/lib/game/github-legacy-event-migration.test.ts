import { describe, expect, it } from 'vitest'
import { asCompanionId, asEventId, type EventLedger, type NormalizedEvent } from './events'
import {
  mergeLegacyGithubEvents,
  retainUnmigratedLegacyGithubData,
} from './github-legacy-event-migration'
import { productEventId } from '../sync/product-event-id'
import { productSnapshotEvent } from '../sync/product-snapshot'

function event(id: string, companionId = 'companion-a'): NormalizedEvent {
  return {
    eventId: asEventId(id),
    companionId: asCompanionId(companionId),
    source: 'github',
    sourceId: 'github-sync',
    provenance: 'verified',
    category: 'new-note',
    occurredAt: '2026-09-24T10:00:00.000Z',
  }
}

function ledger(events: readonly NormalizedEvent[]): EventLedger {
  return { events }
}

function proofs(events: readonly NormalizedEvent[], prefix: string): Record<string, string> {
  return Object.fromEntries(events.map((item, index) => [productEventId(item.eventId), `${prefix}-${index}`]))
}

describe('legacy GitHub event migration', () => {
  it('unions the known 36 overlap + 13 generic-only + 2 account-only case', () => {
    const overlap = Array.from({ length: 36 }, (_, index) => event(`overlap-${index}`))
    const genericOnly = Array.from({ length: 13 }, (_, index) => event(`generic-${index}`))
    const accountOnly = Array.from({ length: 2 }, (_, index) => event(`account-${index}`))
    const genericEvents = [...overlap, ...genericOnly]
    const result = mergeLegacyGithubEvents({
      genericLedger: ledger(genericEvents),
      accountLedger: ledger([...overlap, ...accountOnly]),
      genericProofs: proofs(genericEvents, 'generic-proof'),
      accountProofs: {},
      genericOwnedCompanionIds: ['companion-a'],
      accountOwnedCompanionIds: ['companion-a'],
      genericGuestId: 'guest-generic',
      accountGuestId: 'guest-account',
    })

    expect(result.overlapCount).toBe(36)
    expect(result.genericOnlyCount).toBe(13)
    expect(result.accountOnlyCount).toBe(2)
    expect(result.ledger.events).toHaveLength(51)
    expect(result.migratedEventIds).toHaveLength(49)
    expect(result.migratedGenericEvents).toHaveLength(49)
    expect(result.genericOnlyEvents).toHaveLength(13)
    expect(result.guestIdentityMismatch).toBe(true)
    expect(new Set(result.ledger.events.map((item) => item.eventId)).size).toBe(51)
  })

  it('keeps account receipts authoritative and does not copy orphan generic proofs', () => {
    const shared = event('shared')
    const genericOnly = event('generic-only')
    const accountProof = 'account-receipt'
    const genericProof = 'legacy-receipt'
    const result = mergeLegacyGithubEvents({
      genericLedger: ledger([shared, genericOnly]),
      accountLedger: ledger([shared]),
      genericProofs: {
        [productEventId(shared.eventId)]: genericProof,
        [productEventId(genericOnly.eventId)]: genericProof,
        'event-deadbeef-deadbeef': 'orphan',
      },
      accountProofs: { [productEventId(shared.eventId)]: accountProof },
      genericOwnedCompanionIds: ['companion-a'],
      accountOwnedCompanionIds: ['companion-a'],
    })

    expect(result.proofs[productEventId(shared.eventId)]).toBe(accountProof)
    expect(result.proofs[productEventId(genericOnly.eventId)]).toBe(genericProof)
    expect(result.proofs['event-deadbeef-deadbeef']).toBeUndefined()
  })

  it('does not let different guest IDs replace account-owned event data', () => {
    const accountEvent = event('same-id', 'account-companion')
    const genericEvent = event('same-id', 'generic-companion')
    const result = mergeLegacyGithubEvents({
      genericLedger: ledger([genericEvent]),
      accountLedger: ledger([accountEvent]),
      genericProofs: proofs([genericEvent], 'legacy'),
      accountProofs: {},
      genericOwnedCompanionIds: ['generic-companion'],
      accountOwnedCompanionIds: ['account-companion'],
      genericGuestId: 'guest-a',
      accountGuestId: 'guest-b',
    })

    expect(result.guestIdentityMismatch).toBe(true)
    expect(result.ledger.events[0]?.companionId).toBe(accountEvent.companionId)
    expect(result.genericOnlyEvents).toEqual([])
    expect(result.migratedEventIds).toEqual([])
    expect(result.ledger.events).toHaveLength(1)
  })

  it('upgrades a compatible local account copy with the generic verified receipt', () => {
    const verified = event('upgrade-me')
    const local = { ...verified, provenance: 'local' as const }
    const result = mergeLegacyGithubEvents({
      genericLedger: ledger([verified]),
      accountLedger: ledger([local]),
      genericProofs: proofs([verified], 'legacy'),
      accountProofs: {},
      genericOwnedCompanionIds: ['companion-a'],
      accountOwnedCompanionIds: ['companion-a'],
    })

    expect(result.ledger.events[0]?.provenance).toBe('verified')
    expect(result.proofs[productEventId(verified.eventId)]).toBe('legacy-0')
    expect(result.migratedEventIds).toEqual([productEventId(verified.eventId)])
  })

  it('matches legacy source metadata with its hashed account snapshot form', () => {
    const generic = {
      ...event('metadata-upgrade'),
      metadata: { repositoryId: 'repo-42', linkedPullRequestId: 'pr-9' },
    }
    const account = {
      ...generic,
      sourceId: 'product-snapshot',
      provenance: 'local' as const,
      metadata: { ...productSnapshotEvent(generic).metadata } as Readonly<Record<string, string | number | boolean>>,
    }
    const result = mergeLegacyGithubEvents({
      genericLedger: ledger([generic]),
      accountLedger: ledger([account]),
      genericProofs: proofs([generic], 'legacy'),
      accountProofs: {},
      genericOwnedCompanionIds: ['companion-a'],
      accountOwnedCompanionIds: ['companion-a'],
    })

    expect(result.ledger.events[0]?.provenance).toBe('verified')
    expect(result.migratedEventIds).toEqual([productEventId(generic.eventId)])
  })

  it('does not mark an incompatible overlap as migrated when the account already has a proof', () => {
    const generic = event('incompatible')
    const account = { ...generic, category: 'successful-ci' as const }
    const id = productEventId(generic.eventId)
    const result = mergeLegacyGithubEvents({
      genericLedger: ledger([generic]),
      accountLedger: ledger([account]),
      genericProofs: { [id]: 'legacy-proof' },
      accountProofs: { [id]: 'account-proof' },
      genericOwnedCompanionIds: ['companion-a'],
      accountOwnedCompanionIds: ['companion-a'],
    })

    expect(result.proofs[id]).toBe('account-proof')
    expect(result.migratedEventIds).toEqual([])
  })

  it('keeps an unknown or unowned generic companion and its proof in the generic archive', () => {
    const owned = event('owned-generic', 'generic-owned')
    const unknown = event('unknown-generic', 'not-in-this-profile')
    const result = mergeLegacyGithubEvents({
      genericLedger: ledger([owned, unknown]),
      accountLedger: ledger([]),
      genericProofs: proofs([owned, unknown], 'legacy'),
      accountProofs: {},
      genericOwnedCompanionIds: ['generic-owned'],
      accountOwnedCompanionIds: ['companion-a'],
    })

    expect(result.ledger.events.map((item) => productEventId(item.eventId))).toEqual([productEventId(owned.eventId)])
    expect(result.genericOnlyEvents.map((item) => productEventId(item.eventId))).toEqual([productEventId(owned.eventId)])
    expect(result.migratedEventIds).toEqual([productEventId(owned.eventId)])
    expect(result.migratedGenericEvents.map((item) => productEventId(item.eventId))).toEqual([productEventId(owned.eventId)])
    expect(result.proofs[productEventId(owned.eventId)]).toBe('legacy-0')
    expect(result.proofs[productEventId(unknown.eventId)]).toBeUndefined()
    const retained = retainUnmigratedLegacyGithubData(
      ledger([owned, unknown]),
      proofs([owned, unknown], 'legacy'),
      result.migratedEventIds,
    )
    expect(retained.ledger.events.map((item) => productEventId(item.eventId))).toEqual([
      productEventId(unknown.eventId),
    ])
    expect(retained.proofs[productEventId(unknown.eventId)]).toBe('legacy-1')
    expect(result.skippedGenericEventCount).toBe(1)
  })

  it('leaves the original generic data available until the caller confirms cloud upload', () => {
    const generic = event('generic')
    const other = event('other')
    const original = ledger([generic, other])
    const genericProofs = proofs([generic, other], 'receipt')
    const retained = retainUnmigratedLegacyGithubData(
      original,
      genericProofs,
      [productEventId(generic.eventId)],
    )

    expect(original.events).toHaveLength(2)
    expect(retained.ledger.events.map((item) => item.eventId)).toEqual([other.eventId])
    expect(retained.proofs[productEventId(generic.eventId)]).toBeUndefined()
    expect(retained.proofs[productEventId(other.eventId)]).toBeTruthy()
  })
})
