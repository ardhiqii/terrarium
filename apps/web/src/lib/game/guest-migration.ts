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
 * Returns `null` only when there is nothing to add: no guest profile, or a guest profile
 * whose every reference, egg, and assignment is already under the account key. `null` is
 * what tells the caller the guest copy is redundant and may be removed.
 *
 * WHY A SHARED GUEST ID IS NOT AUTOMATICALLY "NOTHING TO DO": the account adopts the guest
 * id on the first import, so every later sign-in compares two profiles with the SAME id. If
 * the user signed out, played, and signed back in, the guest copy holds that offline
 * progress and the account copy does not. Treating equal ids as "already migrated" discarded
 * it — the profile needs a union whenever the guest side has something the account lacks.
 */
export function planGuestMigration(
  guest: GuestProfile | null,
  account: GuestProfile,
): MigrationPlan | null {
  if (!guest) return null
  const sameIdentity = guest.guestId === account.guestId
  if (sameIdentity && addsNothing(guest, account)) return null

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

  return {
    profile: {
      ...account,
      // The guest identity is adopted, not the account's: the product route refuses an
      // upload whose guest id does not match the row it is writing to, so continuing the
      // guest identity is what lets the merged copy sync at all.
      guestId: guest.guestId,
      updatedAt: new Date().toISOString(),
      activeCompanionId,
      collection,
      eggs,
      assignments,
      // Baselines stay the account's. They are the "what have I already counted" marks
      // for the sources; taking the guest's would re-baseline the account's repos and
      // award their history a second time.
      sourceBaselines: account.sourceBaselines,
    },
    clearGuest: true,
    activeCompanionChanged: activeCompanionId !== account.activeCompanionId,
  }
}

/**
 * True when every entry the guest holds is already in the account copy AND both agree on the
 * active companion.
 *
 * Compared by the same identities the unions use, so "already there" means the merge would be
 * a no-op rather than "the lists happen to look similar". The active companion counts as
 * something to add: the guest was the profile on screen a moment ago, and its choice is what
 * `activeCompanionChanged` exists to surface.
 */
function addsNothing(guest: GuestProfile, account: GuestProfile): boolean {
  const references = new Set(account.collection.map((entry) => entry.referenceId))
  const eggIds = new Set((account.eggs ?? []).map((egg) => egg.drawId))
  const assignmentIds = new Set((account.assignments ?? []).map((assignment) => assignment.referenceId))

  return guest.activeCompanionId === account.activeCompanionId &&
    guest.collection.every((entry) => references.has(entry.referenceId)) &&
    (guest.eggs ?? []).every((egg) => eggIds.has(egg.drawId)) &&
    (guest.assignments ?? []).every((assignment) => assignmentIds.has(assignment.referenceId))
}

/**
 * Every reference from both sides, account first.
 *
 * Keyed on `referenceId`, which is unique per acquisition, so two draws of the same
 * species stay two entries and a duplicate is never silently folded away. Duplicates
 * are what bank Essence, and dropping one would lose it.
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
