/**
 * Presentation logic for the GitHub sync progress indicator.
 *
 * Kept pure and free of React and Node built-ins for two reasons: the repo's
 * Vitest setup runs in a `node` environment with no component renderer, and a
 * `'use client'` consumer must never reach a Node built-in transitively.
 *
 * The percentage is derived from the repository count, because that total is
 * known before the read starts. The request counter is reported as raw activity
 * rather than a fraction, because how many requests a sync will need cannot be
 * known in advance and inventing a denominator would be a lie.
 */

export interface SyncProgressInput {
  /** 1-based index of the repository being read; 0 before the first one starts. */
  repositoryIndex: number
  /** Total repositories this sync will read. 0 means "not known yet". */
  repositoryCount: number
  /** `owner/name` of the repository currently being read. */
  repository: string
  /** Completed HTTP requests so far. */
  requestsDone: number
}

export interface SyncProgressView {
  /** False until the server reports a total, which drives the indeterminate bar. */
  determinate: boolean
  /** Bar fill in the range 0..1, safe to feed straight into `scaleX()`. */
  fraction: number
  percent: number
  /** Clamped 1-based repository index, for display only. */
  index: number
  label: string
  requests: string
  /** Screen-reader description of the whole indicator. */
  ariaText: string
}

const UNKNOWN_REPOSITORY_LABEL = 'your repositories'

function clampFraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function clampIndex(value: number, count: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), count)
}

function formatCount(value: number): string {
  return Number.isFinite(value) && value > 0 ? Math.floor(value).toLocaleString('en-US') : '0'
}

export function syncProgressView(input: SyncProgressInput): SyncProgressView {
  const determinate = Number.isFinite(input.repositoryCount) && input.repositoryCount > 0
  const fraction = determinate ? clampFraction(input.repositoryIndex / input.repositoryCount) : 0
  const percent = Math.round(fraction * 100)
  const index = determinate ? clampIndex(input.repositoryIndex, input.repositoryCount) : 0
  const trimmed = input.repository.trim()
  const label = trimmed.length > 0 ? trimmed : UNKNOWN_REPOSITORY_LABEL
  const requests = formatCount(input.requestsDone)

  const ariaText = determinate
    ? `Reading ${label}, repository ${index} of ${input.repositoryCount}, ${percent} percent, ${requests} requests completed`
    : `Reading ${label}, ${requests} requests completed`

  return { determinate, fraction, percent, index, label, requests, ariaText }
}
