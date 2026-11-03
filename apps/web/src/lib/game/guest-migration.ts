/**
 * Carrying a signed-out guest's progress into their account.
 *
 * WHY THIS EXISTS: signing in used to switch which storage key the app read, and
 * nothing moved the data across. A user who had collected companions, opened eggs, and
 * earned XP while signed out would sign in and find a fresh starter, with their real
 * profile still sitting under the signed-out key. The split was invisible because the
 * pages that read each key disagreed about what they showed.
 *
 * WHAT PRODUCT.md 4.4 REQUIRES, and what this implements:
 *   - "If there is no server profile, import the current companion condition and
 *     collection; keep detailed local-note history on the device."
 *   - "Union collections and preserve each companion's XP independently."
 *   - "Keep the selected active companion when it still exists; otherwise ask the
 *     user to choose one."
 *
 * WHY IT MOVES RATHER THAN COPIES: leaving the guest profile in place would mean two
 * live profiles for one person, and the next sign-out would read the stale one. The
 * guest key is cleared only after the account key holds the merged result.
 *
 * Pure and storage-free: every function takes the two profiles and returns a plan. The
 * caller performs the writes, so a failure part-way through is visible at the call
 * site rather than hidden inside this module.
 */

import { collapseDuplicateStarters } from './guest-profile'
import type { GuestProfile } from './guest-profile'
import type { GuestCollectionReference } from './guest-profile'

export interface MigrationPlan {
  /** The profile to write under the account key. */
  profile: GuestProfile
  /** True when the guest key should be cleared after the write succeeds. */
  clearGuest: boolean
  /**
   * Set when the two profiles disagreed about the active companion and the guest's
   * choice still exists. The caller may surface this; the migration already resolved
   * it in favour of the guest, because that is the profile the user was just looking
   * at when they signed in.
   */
  activeCompanionChanged: boolean
}

/**
 * Merge a signed-out guest profile into an account profile.
 *
 * Returns `null` when there is nothing to do: no guest profile, or a guest profile
 * that is already the one in use (same guest id), which is the normal case for a
 * browser that has only ever used one.
 */
export function planGuestMigration(
  guest: GuestProfile | null,
  account: GuestProfile,
): MigrationPlan | null {
  if (!guest) return null
  // Same identity: the account key already holds this guest's profile, so there is
  // nothing to import and clearing the source would be destructive for no reason.
  if (guest.guestId === account.guestId) return null

  const collection = unionCollection(account.collection, guest.collection)
  const eggs = unionById(account.eggs ?? [], guest.eggs ?? [], (egg) => egg.drawId)
  const assignments = unionById(
    account.assignments ?? [],
    guest.assignments ?? [],
    (assignment) => assignment.referenceId,
  )

  // The guest profile is the one the user was using a moment ago, so its active
  // companion wins when it survived the union. If it did not, keep the account's.
  const guestActiveSurvives = collection.some(
    (entry) => entry.companionId === guest.activeCompanionId,
  )
  const activeCompanionId = guestActiveSurvives
    ? guest.activeCompanionId
    : account.activeCompanionId
  // The guest's chosen INSTANCE, when it survived the union. Two profiles can each
  // hold a starter of the same species, so falling back to the species alone would
  // let the badge land on the account's copy instead of the one just clicked.
  const activeReferenceId = guest.activeReferenceId
    ? collection.find((entry) => entry.referenceId === guest.activeReferenceId)?.referenceId
    : undefined
  const resolvedActiveReferenceId =
    activeReferenceId ??
    collection.find((entry) => entry.companionId === activeCompanionId)?.referenceId

  return {
    profile: collapseDuplicateStarters(
      {
        ...account,
        // The guest identity is adopted, not the account's: the product route refuses an
        // upload whose guest id does not match the row it is writing to, so continuing
        // the guest identity is what lets the merged copy sync at all.
        guestId: guest.guestId,
        updatedAt: new Date().toISOString(),
        activeCompanionId,
        ...(resolvedActiveReferenceId ? { activeReferenceId: resolvedActiveReferenceId } : {}),
        collection,
        eggs,
        assignments,
        // Baselines stay the account's. They are the "what have I already counted" marks
        // for the sources; taking the guest's would re-baseline the account's repos and
        // award their history a second time.
        sourceBaselines: account.sourceBaselines,
      },
      new Date().toISOString(),
    ),
    clearGuest: true,
    activeCompanionChanged: activeCompanionId !== account.activeCompanionId,
  }
}

/**
 * Every reference from both sides, account first.
 *
 * Keyed on `referenceId`, which is unique per acquisition, so two draws of the same
 * species stay two entries and a duplicate is never silently folded away. Duplicates
 * are what bank Essence, and dropping one would lose it.
 *
 * The one exception is applied by the caller: two STARTERS of the same species are
 * not collected duplicates but the same grant arriving from two profiles, and
 * `collapseDuplicateStarters` folds those before the plan is returned.
 */
function unionCollection(
  account: readonly GuestCollectionReference[],
  guest: readonly GuestCollectionReference[],
): readonly GuestCollectionReference[] {
  return unionById(account, guest, (entry) => entry.referenceId)
}

/** Concatenate, keeping the first of each identity and preserving order. */
function unionById<T>(first: readonly T[], second: readonly T[], key: (item: T) => string): readonly T[] {
  const seen = new Set(first.map(key))
  const extra = second.filter((item) => {
    const id = key(item)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  return [...first, ...extra]
}
