import { asEventId, type EventId, type NormalizedEvent } from '../game/events'

/**
 * Product snapshots intentionally store opaque event IDs instead of source
 * identities. Keeping this transform idempotent lets a restored snapshot
 * deduplicate the next delivery of the same source event.
 */
const PRODUCT_EVENT_ID = /^event-[0-9a-f]{8}-[0-9a-f]{8}$/u
const PRODUCT_OPAQUE_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{8}$/u

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

export function productEventId(sourceEventId: string): EventId {
  const normalized = sourceEventId.trim()
  return asEventId(PRODUCT_EVENT_ID.test(normalized) ? normalized : opaqueId(normalized, 'event'))
}

/**
 * Product ledgers can contain a restored opaque cap key and a fresh provider
 * cap key in the same browser session. Canonicalizing both to one stable form
 * keeps `events.ts`'s literal-key cap grouping idempotent across restores.
 */
export function productCapKey(sourceCapKey: string): string {
  const normalized = sourceCapKey.trim()
  const marker = 'cap-'
  return normalized.startsWith(marker) && PRODUCT_OPAQUE_SUFFIX.test(normalized.slice(marker.length))
    ? normalized
    : opaqueId(normalized, marker.slice(0, -1))
}

export function canonicalizeProductEvent(event: NormalizedEvent): NormalizedEvent {
  const eventId = productEventId(event.eventId)
  const cap = event.cap
    ? { ...event.cap, key: productCapKey(event.cap.key) }
    : undefined
  if (event.eventId === eventId && cap?.key === event.cap?.key) return event
  return {
    ...event,
    eventId,
    ...(cap ? { cap } : {}),
  }
}
