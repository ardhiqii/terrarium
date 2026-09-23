/**
 * Guest-identity conflict: the choice a `409` refusal leaves to the user.
 *
 * A signed-in account can end up holding two guest identities at once — the one
 * in this browser and the one inside the account's cloud snapshot. Every
 * `POST /api/sync/product` then answers 409 with the same sentence, the cloud
 * backup is never written, and without a deliberate choice the user is stuck.
 *
 * The refusal itself is correct and stays: it is what stops a different browser
 * from silently overwriting an account's snapshot. What this module adds is the
 * decision layer around that refusal — how to recognise it precisely, how to
 * describe both sides from their snapshots, which actions exist, what each one
 * does, and when a destructive one must ask first.
 *
 * PURITY: this file has no runtime imports at all — no React, no DOM, no
 * `node:*`, no localStorage. The panel wires state and buttons; every branch
 * below is plain data in, data out, so it is unit-testable without a component
 * harness.
 */

import type { GuestProfile } from './guest-profile'

/** The exact refusal text the product route answers when two guest identities collide. */
export const GUEST_IDENTITY_CONFLICT_ERROR =
  'This GitHub account already has a different guest profile.'

export type GuestIdentitySide = 'local' | 'cloud'

export type GuestIdentityConflictAction = 'keep-both' | 'use-browser' | 'use-account'

/**
 * What one side actually holds, read from a serialized product snapshot.
 *
 * Deliberately tolerant: a truncated or older snapshot still produces a usable
 * description instead of throwing, because this data is shown next to a
 * destructive decision and "could not read it" must be a visible state, not a
 * crash.
 */
export interface GuestIdentitySideSummary {
  readonly guestId: string
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly eventCount: number
  readonly companionCount: number
  readonly collectionCount: number
  readonly baselineCount: number
  readonly totalXp: number
  readonly totalEssence: number
  /** No events, no baselines, at most the starter companion, no XP. */
  readonly isBlank: boolean
}

/** One explicit action, with the consequences its label cannot carry alone. */
export interface GuestIdentityActionPlan {
  readonly action: GuestIdentityConflictAction
  readonly label: string
  readonly description: string
  readonly recommended: boolean
  /** Discards one of the two copies. */
  readonly destructive: boolean
  /** Refuses to run from a single click; the confirm step is mandatory. */
  readonly requiresConfirmation: boolean
  /** The local namespace adopts the account's cloud guest identity. */
  readonly adoptsAccountIdentity: boolean
  /** The account's cloud snapshot is deleted before the re-upload. */
  readonly discardsCloudSnapshot: boolean
  /** Local progression for this namespace is replaced by the account's copy. */
  readonly replacesLocalProgress: boolean
  /** The snapshot is uploaded again after the local change. */
  readonly reuploads: boolean
  /** Whether the sides that were read can support this action. */
  readonly available: boolean
}

export interface GuestIdentityConflictView {
  /** The two sides turned out to share one identity (the account changed since the refusal). */
  readonly sameIdentity: boolean
  /** The account's cloud snapshot could be read, so identity adoption is possible. */
  readonly cloudAvailable: boolean
  readonly local: GuestIdentitySideSummary
  readonly cloud: GuestIdentitySideSummary | null
  /** Sides with no progression to preserve. */
  readonly emptySides: readonly GuestIdentitySide[]
  /** Both sides hold real progress under different identities. */
  readonly bothSidesHoldProgress: boolean
  readonly headline: string
  readonly actions: readonly GuestIdentityActionPlan[]
}

export interface GuestIdentitySideDescription {
  readonly guestIdShort: string
  readonly events: string
  readonly companions: string
  readonly xp: string
  readonly createdAt: string | null
  readonly emptinessNote: string | null
}

export type GuestIdentityActionResult = 'succeeded' | 'failed'

/** Which part of an action failed, so the summary can say what still holds. */
export type GuestIdentityActionStep =
  | 'read-cloud'
  | 'delete-cloud'
  | 'adopt-identity'
  | 'replace-local'
  | 'upload'

export interface GuestIdentityActionOutcome {
  readonly result: GuestIdentityActionResult
  readonly step?: GuestIdentityActionStep
  /** Server or storage error text; falls back to a retry hint. */
  readonly detail?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function finiteNumberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function timestampOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

function sumCompanionField(companions: readonly unknown[], field: 'xp' | 'essence'): number {
  return companions.reduce<number>(
    (sum, companion) => sum + (isRecord(companion) ? finiteNumberOrZero(companion[field]) : 0),
    0,
  )
}

/**
 * Recognise the identity guard precisely: HTTP 409 AND the exact refusal text.
 *
 * A 409 from this route also covers checkpoint and optimistic-concurrency
 * races, and those must keep their own, retryable explanation instead of being
 * dressed up as an identity choice.
 */
export function isGuestIdentityConflict(status: number, body: unknown): boolean {
  if (status !== 409) return false
  if (!isRecord(body) || typeof body.error !== 'string') return false
  return body.error.trim() === GUEST_IDENTITY_CONFLICT_ERROR
}

/** Describe a serialized `ProductSnapshot`. Returns null when nothing usable is there. */
export function summarizeGuestSnapshot(value: unknown): GuestIdentitySideSummary | null {
  if (!isRecord(value)) return null
  const guestId = typeof value.guestId === 'string' ? value.guestId.trim() : ''
  if (guestId.length === 0) return null

  const companions = Array.isArray(value.companions) ? value.companions : []
  const eventCount = countOf(value.events)
  const collectionCount = countOf(value.collection)
  const baselineCount = countOf(value.sourceBaselines)
  const totalXp = sumCompanionField(companions, 'xp')
  const totalEssence = sumCompanionField(companions, 'essence')
  return {
    guestId,
    createdAt: timestampOrNull(value.createdAt),
    updatedAt: timestampOrNull(value.updatedAt),
    eventCount,
    companionCount: companions.length,
    collectionCount,
    baselineCount,
    totalXp,
    totalEssence,
    // A starter-only snapshot is empty even though it holds one collection
    // entry, and XP without events/collection would be a malformed copy that
    // must not be waved through as "nothing to lose".
    isBlank: eventCount === 0 && baselineCount === 0 && collectionCount <= 1 && totalXp === 0,
  }
}

function shortGuestId(guestId: string): string {
  return guestId.length <= 16 ? guestId : `…${guestId.slice(-12)}`
}

/** Human phrasing for one side's contents, used verbatim by the chooser. */
export function describeGuestIdentitySide(side: GuestIdentitySideSummary): GuestIdentitySideDescription {
  return {
    guestIdShort: shortGuestId(side.guestId),
    events: side.eventCount === 1 ? '1 event' : `${side.eventCount} events`,
    companions: side.companionCount === 1 ? '1 companion' : `${side.companionCount} companions`,
    xp: `${side.totalXp} XP`,
    createdAt: side.createdAt,
    emptinessNote: side.isBlank ? 'No progression yet.' : null,
  }
}

function actionPlan(
  action: GuestIdentityConflictAction,
  values: Omit<GuestIdentityActionPlan, 'action' | 'recommended' | 'destructive' | 'requiresConfirmation'> &
    Partial<Pick<GuestIdentityActionPlan, 'recommended' | 'destructive' | 'requiresConfirmation'>>,
): GuestIdentityActionPlan {
  return {
    action,
    recommended: false,
    destructive: false,
    requiresConfirmation: false,
    ...values,
  }
}

function conflictHeadline(
  local: GuestIdentitySideSummary,
  cloud: GuestIdentitySideSummary | null,
): string {
  if (!cloud) {
    return "The account's cloud copy could not be read, so only this browser's copy is available right now."
  }
  if (cloud.guestId === local.guestId) {
    return local.isBlank && cloud.isBlank
      ? 'Both copies now share one identity and hold no progress yet. Retry the backup or start over deliberately.'
      : 'Both copies now share one identity. The earlier upload was refused; choose how to continue.'
  }
  if (local.isBlank && cloud.isBlank) {
    return 'Both copies hold no progress and use different identities. Choose which identity the account keeps.'
  }
  if (local.isBlank) {
    return "This browser holds no progress yet, while the account's cloud copy does. Choose how the backup keeps them."
  }
  if (cloud.isBlank) {
    return "This browser holds progress, while the account's cloud copy is empty. Choose how the backup keeps them."
  }
  return "This browser and the account's cloud copy each hold their own progress under different identities. Choose how the backup keeps them."
}

/**
 * Build the whole chooser: identity comparison, which sides are empty, the
 * headline, and one plan per action with availability and the confirm rule.
 */
export function describeGuestIdentityConflict(
  local: GuestIdentitySideSummary,
  cloud: GuestIdentitySideSummary | null,
): GuestIdentityConflictView {
  const sameIdentity = cloud !== null && cloud.guestId === local.guestId
  const emptySides: GuestIdentitySide[] = [
    ...(local.isBlank ? (['local'] as const) : []),
    ...(cloud && cloud.isBlank ? (['cloud'] as const) : []),
  ]
  const cloudAvailable = cloud !== null
  // "Use the account" is destructive only when it actually replaces earned
  // local progress; an empty browser copy has nothing to confirm.
  const replacingLocalProgress = !local.isBlank

  return {
    sameIdentity,
    cloudAvailable,
    local,
    cloud,
    emptySides,
    bothSidesHoldProgress: cloud !== null && !local.isBlank && !cloud.isBlank,
    headline: conflictHeadline(local, cloud),
    actions: [
      actionPlan('keep-both', {
        label: 'Keep both',
        description: cloudAvailable
          ? "Adopt the account's guest identity here, keep this browser's progress, and upload the combined copy. Nothing is dropped."
          : "Adopt the account's guest identity here and upload this browser's progress. Needs the account's copy to be readable first.",
        recommended: true,
        adoptsAccountIdentity: true,
        discardsCloudSnapshot: false,
        replacesLocalProgress: false,
        reuploads: true,
        available: cloudAvailable,
      }),
      actionPlan('use-browser', {
        label: 'Use this browser',
        description: cloudAvailable
          ? "Delete the account's cloud copy and replace it with this browser's progress. Whatever the cloud copy holds is discarded."
          : "Delete the account's cloud copy and replace it with this browser's progress. The unreadable cloud copy is discarded.",
        destructive: true,
        requiresConfirmation: true,
        adoptsAccountIdentity: false,
        discardsCloudSnapshot: true,
        replacesLocalProgress: false,
        reuploads: true,
        available: true,
      }),
      actionPlan('use-account', {
        label: 'Use the account',
        description: cloudAvailable
          ? "Replace this browser's progress for this account with the account's cloud copy, adopt its guest identity, and upload the result."
          : "Follow the account's cloud copy once it can be read. Nothing local changes until then.",
        destructive: replacingLocalProgress,
        requiresConfirmation: replacingLocalProgress,
        adoptsAccountIdentity: true,
        discardsCloudSnapshot: false,
        replacesLocalProgress: true,
        reuploads: true,
        available: cloudAvailable,
      }),
    ],
  }
}

/**
 * Adopt the account's guest identity while keeping the local progression.
 *
 * The starter reference is the only collection entry that embeds an identity:
 * a locally created profile stores `${guestId}:starter`, while a profile
 * restored from the cloud already stores the account's opaque reference. The
 * account's own starter reference wins whenever it is known, so the next merge
 * unions one starter entry instead of two (which would inflate its encounter
 * count). Encounter references use their own draw IDs and are never touched.
 */
export function adoptAccountGuestIdentity(
  profile: GuestProfile,
  accountGuestId: string,
  now: string,
  accountStarterReferenceId: string | null = null,
): GuestProfile {
  const localStarterReferenceId = `${profile.guestId}:starter`
  const starterReplacement = accountStarterReferenceId && accountStarterReferenceId.length > 0
    ? accountStarterReferenceId
    : null
  return {
    ...profile,
    guestId: accountGuestId,
    updatedAt: now,
    collection: profile.collection.map((reference) => {
      if (reference.acquisition !== 'starter') return reference
      if (starterReplacement) return { ...reference, referenceId: starterReplacement }
      // No account reference was supplied: only a locally created starter can
      // be re-derived. An opaque `ref-…` id came from the cloud already and is
      // left exactly as it is.
      return reference.referenceId === localStarterReferenceId
        ? { ...reference, referenceId: `${accountGuestId}:starter` }
        : reference
    }),
  }
}

export function guestIdentityActionPlan(
  view: GuestIdentityConflictView,
  action: GuestIdentityConflictAction,
): GuestIdentityActionPlan | null {
  return view.actions.find((plan) => plan.action === action) ?? null
}

/**
 * The single gate every action must pass through.
 *
 * A destructive action is refused unless the caller has already collected the
 * user's explicit confirmation, so a single mis-wired click cannot delete an
 * account's copy or replace local progression.
 */
export function canRunGuestIdentityAction(
  view: GuestIdentityConflictView,
  action: GuestIdentityConflictAction,
  confirmed: boolean,
): boolean {
  const plan = guestIdentityActionPlan(view, action)
  if (!plan || !plan.available) return false
  return !plan.requiresConfirmation || confirmed
}

function outcomeDetail(outcome: GuestIdentityActionOutcome): string {
  const detail = outcome.detail?.trim()
  return detail && detail.length > 0 ? detail : 'try again'
}

/**
 * One line for the existing sync summary, honest about which step failed and
 * what therefore still holds.
 */
export function guestIdentityActionSummary(
  action: GuestIdentityConflictAction,
  outcome: GuestIdentityActionOutcome,
): string {
  const detail = outcomeDetail(outcome)
  if (outcome.result === 'succeeded') {
    if (action === 'keep-both') {
      return "Cloud backup settled · this browser's progress and the account's copy are now one, under the account's guest identity."
    }
    if (action === 'use-browser') {
      return "Cloud copy replaced · the account's cloud copy now holds this browser's progress."
    }
    return "Cloud copy restored · this browser now follows the account's progress."
  }

  const step = outcome.step ?? 'upload'
  if (action === 'use-browser') {
    if (step === 'delete-cloud') {
      return `Cloud copy was not replaced · the account's cloud copy could not be removed: ${detail}`
    }
    return `Cloud copy removed · the account's cloud copy was deleted, but this browser's copy could not be uploaded: ${detail}`
  }
  if (action === 'keep-both') {
    if (step === 'adopt-identity') {
      return `Cloud backup was not saved · the account's guest identity could not be stored in this browser: ${detail}`
    }
    if (step === 'read-cloud') {
      return `Cloud backup was not saved · the account's cloud copy could not be read: ${detail}`
    }
    return `Cloud backup was not saved · this browser adopted the account's identity, but the upload failed: ${detail}`
  }
  if (step === 'replace-local') {
    return `Cloud copy was not restored · this browser could not store the account's copy: ${detail}`
  }
  if (step === 'read-cloud') {
    return `Cloud copy was not restored · the account's cloud copy could not be read: ${detail}`
  }
  return `Cloud copy restored locally · the account's copy could not be uploaded again: ${detail}`
}
