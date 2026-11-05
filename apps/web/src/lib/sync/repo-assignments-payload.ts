/**
 * Validation for `PUT /api/profile/repo-assignments`
 * (docs-plan/PLAN-dressed-repo-qa-fixes.md, fix 1).
 *
 * Kept out of the route file because a Next route module may only export its
 * handlers and route config. Pure, so it is unit-tested directly.
 */

import type { ProductSnapshotAssignment } from './product-snapshot'

/** One assignment per owned companion; no real collection is near this. */
export const MAX_ASSIGNMENTS = 500
export const MAX_ASSIGNMENTS_BODY_BYTES = 128 * 1024
const ASSIGNMENT_KEYS = ['repositoryId', 'referenceId', 'companionId', 'assignedAt'] as const
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const MAX_ID_LENGTH = 200

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

export type ParsedAssignmentsBody =
  | { ok: true; guestId: string; assignments: ProductSnapshotAssignment[] }
  | { ok: false; error: string }

/** Strict: unknown fields, duplicates and malformed entries are refused, never coerced. */
export function parseAssignmentsBody(body: unknown): ParsedAssignmentsBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be an object.' }
  }
  const record = body as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'guestId' && key !== 'assignments')) {
    return { ok: false, error: 'Unknown field in body.' }
  }
  if (!isBoundedString(record.guestId)) return { ok: false, error: 'guestId is required.' }
  const list = record.assignments
  if (!Array.isArray(list)) return { ok: false, error: 'assignments must be an array.' }
  if (list.length > MAX_ASSIGNMENTS) return { ok: false, error: 'Too many assignments.' }

  const repos = new Set<string>()
  const references = new Set<string>()
  const assignments: ProductSnapshotAssignment[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: 'Each assignment must be an object.' }
    }
    const item = entry as Record<string, unknown>
    const keys = Object.keys(item)
    if (keys.length !== ASSIGNMENT_KEYS.length || !ASSIGNMENT_KEYS.every((key) => key in item)) {
      return { ok: false, error: 'Each assignment needs exactly repositoryId, referenceId, companionId and assignedAt.' }
    }
    const { repositoryId, referenceId, companionId, assignedAt } = item
    if (typeof repositoryId !== 'string' || !/^[1-9]\d{0,19}$/.test(repositoryId)) {
      return { ok: false, error: 'repositoryId must be a numeric GitHub id.' }
    }
    if (!isBoundedString(referenceId) || !isBoundedString(companionId)) {
      return { ok: false, error: 'referenceId and companionId must be short non-empty strings.' }
    }
    if (typeof assignedAt !== 'string' || !ISO_TIMESTAMP.test(assignedAt) || Number.isNaN(Date.parse(assignedAt))) {
      return { ok: false, error: 'assignedAt must be an ISO timestamp.' }
    }
    // One companion per repository, each companion spent once (PRODUCT.md §6.3).
    if (repos.has(repositoryId) || references.has(referenceId)) {
      return { ok: false, error: 'A repository or companion appears twice.' }
    }
    repos.add(repositoryId)
    references.add(referenceId)
    assignments.push({ repositoryId, referenceId, companionId, assignedAt })
  }
  return { ok: true, guestId: record.guestId, assignments }
}
