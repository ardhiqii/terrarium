import type { ProductSnapshotEvent } from './product-snapshot'

/**
 * Canonical fields covered by a server-issued GitHub activity receipt.
 * Keeping this module free of Node imports makes it safe for the browser-side
 * snapshot builder to share the exact payload shape with the API verifier.
 */
export function productEventProofPayload(event: ProductSnapshotEvent, githubId: number): string {
  return JSON.stringify({
    githubId,
    eventId: event.eventId,
    companionId: event.companionId,
    source: event.source,
    category: event.category,
    occurredAt: event.occurredAt,
    cap: event.cap ?? null,
    metadata: event.metadata ?? null,
  })
}
