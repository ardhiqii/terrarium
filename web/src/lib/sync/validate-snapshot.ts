/**
 * Validates an unknown request body against the closed `SyncedSnapshot`
 * shape (`./types.ts`, frozen) for `POST /api/sync`.
 *
 * Per T28: a client sending an extra field (e.g. `{ noteTitles: [...] }`)
 * must get a 400, not have the field silently dropped. Silently ignoring
 * unknown fields would make a future accidental (or malicious) client-side
 * change that starts sending note content invisible at this boundary -- the
 * whole point of the closed shape in `types.ts` is that such a change has
 * to be noticed. So this checks the exact key set, not just that the known
 * keys are present and well-typed.
 */

import { STAGES } from '../game/types'
import type { StageId } from '../game/types'
import type { SyncedSnapshot } from './types'

const STAGE_IDS = new Set<string>(STAGES.map((s) => s.id))

const REQUIRED_KEYS = [
  'schemaVersion',
  'totalXp',
  'stage',
  'stageIndex',
  'noteCount',
  'projectCount',
  'totalWords',
  'tagCount',
  'companions',
  'unlockedItemIds',
  'generatedAt',
] as const

export type ValidationResult =
  | { ok: true; value: SyncedSnapshot }
  | { ok: false; error: string }

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStageId(v: unknown): v is StageId {
  return typeof v === 'string' && STAGE_IDS.has(v)
}

export function validateSnapshot(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }

  const record = body as Record<string, unknown>
  const keys = Object.keys(record)

  const unknownKeys = keys.filter((k) => !(REQUIRED_KEYS as readonly string[]).includes(k))
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `Unknown field(s): ${unknownKeys.join(', ')}. Only derived state may be synced.`,
    }
  }

  const missingKeys = REQUIRED_KEYS.filter((k) => !(k in record))
  if (missingKeys.length > 0) {
    return { ok: false, error: `Missing field(s): ${missingKeys.join(', ')}.` }
  }

  if (!isFiniteNumber(record.schemaVersion)) {
    return { ok: false, error: '"schemaVersion" must be a number.' }
  }
  if (!isFiniteNumber(record.totalXp)) {
    return { ok: false, error: '"totalXp" must be a number.' }
  }
  if (!isStageId(record.stage)) {
    return { ok: false, error: `"stage" must be one of: ${[...STAGE_IDS].join(', ')}.` }
  }
  if (!isFiniteNumber(record.stageIndex)) {
    return { ok: false, error: '"stageIndex" must be a number.' }
  }
  if (!isFiniteNumber(record.noteCount)) {
    return { ok: false, error: '"noteCount" must be a number.' }
  }
  if (!isFiniteNumber(record.projectCount)) {
    return { ok: false, error: '"projectCount" must be a number.' }
  }
  if (!isFiniteNumber(record.totalWords)) {
    return { ok: false, error: '"totalWords" must be a number.' }
  }
  if (!isFiniteNumber(record.tagCount)) {
    return { ok: false, error: '"tagCount" must be a number.' }
  }
  if (!Array.isArray(record.companions)) {
    return { ok: false, error: '"companions" must be an array.' }
  }
  for (const [i, entry] of record.companions.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `"companions[${i}]" must be an object.` }
    }
    const companionRecord = entry as Record<string, unknown>
    const companionKeys = Object.keys(companionRecord)
    const allowedCompanionKeys = ['stage', 'stageIndex']
    const unknownCompanionKeys = companionKeys.filter((k) => !allowedCompanionKeys.includes(k))
    if (unknownCompanionKeys.length > 0) {
      return {
        ok: false,
        error: `"companions[${i}]" has unknown field(s): ${unknownCompanionKeys.join(', ')}.`,
      }
    }
    if (!isStageId(companionRecord.stage)) {
      return { ok: false, error: `"companions[${i}].stage" must be a valid stage id.` }
    }
    if (!isFiniteNumber(companionRecord.stageIndex)) {
      return { ok: false, error: `"companions[${i}].stageIndex" must be a number.` }
    }
  }
  if (
    !Array.isArray(record.unlockedItemIds) ||
    !record.unlockedItemIds.every((id) => typeof id === 'string')
  ) {
    return { ok: false, error: '"unlockedItemIds" must be an array of strings.' }
  }
  if (typeof record.generatedAt !== 'string' || Number.isNaN(Date.parse(record.generatedAt))) {
    return { ok: false, error: '"generatedAt" must be an ISO timestamp string.' }
  }

  return {
    ok: true,
    value: {
      schemaVersion: record.schemaVersion as number,
      totalXp: record.totalXp as number,
      stage: record.stage as StageId,
      stageIndex: record.stageIndex as number,
      noteCount: record.noteCount as number,
      projectCount: record.projectCount as number,
      totalWords: record.totalWords as number,
      tagCount: record.tagCount as number,
      companions: (record.companions as Array<{ stage: StageId; stageIndex: number }>).map(
        (c) => ({ stage: c.stage, stageIndex: c.stageIndex })
      ),
      unlockedItemIds: [...(record.unlockedItemIds as string[])],
      generatedAt: record.generatedAt as string,
    },
  }
}
