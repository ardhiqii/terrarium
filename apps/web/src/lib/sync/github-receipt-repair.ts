import type { ProductSnapshotEvent } from './product-snapshot'

/** The product route exposes at most this many failures per upload. */
export const MAX_RECEIPT_REPAIR_EVENT_IDS = 5
export const PRODUCT_EVENT_ID_PATTERN = /^event-[0-9a-f]{8}-[0-9a-f]{8}$/u
export const PAYLOAD_DIGEST_PATTERN = /^[0-9a-f]{16}$/u

export interface ReceiptFailure {
  readonly eventId: string
  readonly reason: string
  readonly payloadDigest: string | null
}

export interface ReceiptRepairBlocked {
  readonly eventId: string
  readonly reason: string
}

export interface ReceiptRepairItem {
  readonly eventId: string
  readonly proof: string
  readonly payloadDigest: string
  /** Canonical server-owned event fields used only for proof replacement checks. */
  readonly event: ProductSnapshotEvent
}

export interface ReceiptRepairResponse {
  readonly repaired: readonly ReceiptRepairItem[]
  readonly blocked: readonly ReceiptRepairBlocked[]
  readonly requestsDone: number
  readonly repositoryCount: number
  readonly skippedRepositoryCount: number
  readonly syncStatus: 'ok' | 'partial' | 'unavailable'
  readonly truncated: boolean
}

export interface StoredReceiptFailure {
  readonly eventId: string
  readonly reason: string
  readonly payloadDigest: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanEventId(value: unknown): string | null {
  return typeof value === 'string' && PRODUCT_EVENT_ID_PATTERN.test(value) ? value : null
}

function cleanDigest(value: unknown): string | null {
  return typeof value === 'string' && PAYLOAD_DIGEST_PATTERN.test(value) ? value : null
}

/** Parse the bounded diagnostics returned by POST /api/sync/product. */
export function parseReceiptFailures(value: unknown): ReceiptFailure[] {
  if (!isRecord(value) || !Array.isArray(value.receiptFailures)) return []
  const seen = new Set<string>()
  const failures: ReceiptFailure[] = []
  for (const item of value.receiptFailures) {
    if (!isRecord(item)) continue
    const eventId = cleanEventId(item.eventId)
    if (!eventId || seen.has(eventId)) continue
    const reason = typeof item.reason === 'string' && item.reason.trim().length > 0
      ? item.reason
      : 'receipt-rejected'
    seen.add(eventId)
    failures.push({
      eventId,
      reason,
      payloadDigest: cleanDigest(item.payloadDigest),
    })
    if (failures.length >= MAX_RECEIPT_REPAIR_EVENT_IDS) break
  }
  return failures
}

export function receiptFailureEventIds(failures: readonly ReceiptFailure[]): string[] {
  return [...new Set(failures.map((failure) => failure.eventId))].slice(0, MAX_RECEIPT_REPAIR_EVENT_IDS)
}

/**
 * Validate the repair response without trusting it as product state. The final
 * product route still verifies each HMAC receipt; this parser only prevents a
 * malformed response from replacing an unrelated browser proof.
 */
export function parseReceiptRepairResponse(value: unknown): ReceiptRepairResponse | null {
  if (!isRecord(value)) return null
  const rawRepaired = Array.isArray(value.repaired) ? value.repaired : []
  const repaired: ReceiptRepairItem[] = []
  const seen = new Set<string>()
  for (const item of rawRepaired) {
    if (!isRecord(item)) continue
    const eventId = cleanEventId(item.eventId)
    const proof = typeof item.proof === 'string' && item.proof.length > 0 && item.proof.length <= 128
      ? item.proof
      : null
    const payloadDigest = cleanDigest(item.payloadDigest)
    if (!eventId || !proof || !payloadDigest || seen.has(eventId) || !isRecord(item.event)) continue
    // The product route is the authoritative shape validator. Keep this
    // response parser deliberately narrow: only an event with the same stable
    // ID and a normal object can participate in the retry.
    if (cleanEventId(item.event.eventId) !== eventId) continue
    seen.add(eventId)
    repaired.push({
      eventId,
      proof,
      payloadDigest,
      event: item.event as unknown as ProductSnapshotEvent,
    })
    if (repaired.length >= MAX_RECEIPT_REPAIR_EVENT_IDS) break
  }

  const rawBlocked = Array.isArray(value.blocked) ? value.blocked : []
  const blocked: ReceiptRepairBlocked[] = []
  for (const item of rawBlocked) {
    if (!isRecord(item)) continue
    const eventId = cleanEventId(item.eventId)
    if (!eventId || seen.has(eventId) || blocked.some((entry) => entry.eventId === eventId)) continue
    blocked.push({
      eventId,
      reason: typeof item.reason === 'string' && item.reason.trim().length > 0
        ? item.reason
        : 'receipt-could-not-be-repaired',
    })
    if (blocked.length >= MAX_RECEIPT_REPAIR_EVENT_IDS) break
  }

  const numberOrZero = (candidate: unknown): number =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? Math.round(candidate)
      : 0
  const status = value.syncStatus === 'partial' || value.syncStatus === 'unavailable'
    ? value.syncStatus
    : 'ok'
  return {
    repaired,
    blocked,
    requestsDone: numberOrZero(value.requestsDone),
    repositoryCount: numberOrZero(value.repositoryCount),
    skippedRepositoryCount: numberOrZero(value.skippedRepositoryCount),
    syncStatus: status,
    truncated: value.truncated === true,
  }
}

/** Replace only receipts that the server repaired; unrelated proofs survive. */
export function mergeRepairedProofs(
  existing: Readonly<Record<string, string>>,
  repaired: readonly ReceiptRepairItem[],
): Record<string, string> {
  const next = { ...existing }
  for (const item of repaired) next[item.eventId] = item.proof
  return next
}

/**
 * A blocked event stays in the browser ledger. This projection is only for a
 * best-effort cloud upload of unrelated valid progress; callers must keep the
 * original state and recovery record locally and must not adopt this response
 * as the browser state.
 */
export function blockedEventIds(
  blocked: readonly ReceiptRepairBlocked[],
): ReadonlySet<string> {
  return new Set(blocked.map((entry) => entry.eventId))
}
