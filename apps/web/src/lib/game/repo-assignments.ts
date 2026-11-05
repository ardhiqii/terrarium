/**
 * Which companion is dressed onto which repository.
 *
 * WHY THIS IS A SEPARATE MODULE FROM guest-profile.ts: the profile owns the
 * shape and its validation; this owns the RULE. The rule is the product
 * decision, and it is the part most likely to be re-tuned, so it lives where it
 * can be read and tested without a storage mock in the way.
 *
 * THE RULE, in one line: you can dress as many repositories as you own
 * companions, and each companion is spent on exactly one repository.
 *
 * WHY THE BOUND IS `collection.length` AND NOT "distinct species": the activity
 * panel already tells the user "N companions". If the collection says five and
 * only two repositories can be dressed because two of the five are the same
 * species, the number on screen is lying. Two Pikachu draws are two collection
 * entries and two usable companions. Whatever the collection displays is what
 * the bound must be, or the interface contradicts itself.
 *
 * WHY EACH COMPANION IS SPENT, NOT SHARED: sharing one companion across every
 * repository makes the bound meaningless. Owning one companion would dress a
 * hundred repositories, and the collection would stop being a resource you
 * manage. Spending is the reading that makes the collection mean something.
 *
 * WHY ASSIGNMENTS KEY ON `referenceId` AND NOT ON THE SPECIES: `companionId` is
 * a catalog id shared by every draw of that species (`pikachu-family`), so it
 * cannot distinguish the three Pikachu a user owns. `referenceId` is unique per
 * acquisition, which is exactly the identity being spent. The species travels
 * along on the assignment because the sprite lookup needs it, not because it
 * identifies anything.
 *
 * Pure and storage-free: every function takes a profile and returns a new one.
 */

import type { GuestProfile } from './guest-profile'

/** Why an assignment was refused. Surfaced so the UI can say which one it was. */
export type AssignmentRefusal =
  | 'repository-already-dressed'
  | 'companion-not-owned'
  | 'companion-already-spent'

export interface RepoAssignment {
  /** GitHub's numeric repository id, stable across renames. */
  repositoryId: string
  /**
   * The specific companion instance being spent. Unique per acquisition, so two
   * draws of the same species are two distinct assignments.
   */
  referenceId: string
  /** The catalog id, carried for the sprite lookup. */
  companionId: string
  assignedAt: string
}

export type AssignOutcome =
  | { ok: true; profile: GuestProfile }
  | { ok: false; reason: AssignmentRefusal }

/**
 * Every companion the user owns, in acquisition order.
 *
 * This is the single definition of "what you own" that both the bound and the
 * picker read, so they can never disagree.
 */
export function ownedCompanions(
  profile: GuestProfile,
): readonly GuestProfile['collection'][number][] {
  return profile.collection
}

/** Assignments currently in force, newest last. */
export function assignments(profile: GuestProfile): readonly RepoAssignment[] {
  return profile.assignments ?? []
}

/** The companion dressed on a repository, if any. */
export function assignmentForRepository(
  profile: GuestProfile,
  repositoryId: string,
): RepoAssignment | undefined {
  return assignments(profile).find((a) => a.repositoryId === repositoryId)
}

/** True when the companion instance is already spent on some repository. */
export function isSpent(profile: GuestProfile, referenceId: string): boolean {
  return assignments(profile).some((a) => a.referenceId === referenceId)
}

/** How many repositories may still be dressed. Never negative. */
export function remainingAssignments(profile: GuestProfile): number {
  return Math.max(0, ownedCompanions(profile).length - assignments(profile).length)
}

/**
 * The companions that could still be dressed, and why each one cannot.
 * The picker renders from this so it never offers a choice that will be refused.
 */
export function assignableCompanions(
  profile: GuestProfile,
): readonly { referenceId: string; companionId: string; assignable: boolean }[] {
  return ownedCompanions(profile).map((entry) => ({
    referenceId: entry.referenceId,
    companionId: entry.companionId,
    assignable: !isSpent(profile, entry.referenceId),
  }))
}

/**
 * Refuse rather than repair, in a fixed order, so the message a user sees is
 * the one that actually applies: a repository already dressed is the most
 * specific problem, a companion already spent is next.
 *
 * There is deliberately no "out of companions" branch. It would be unreachable:
 * if the companion is owned (checked above) and not yet spent, then at most
 * `owned - 1` others are spent, so at least this one is still free. An
 * unreachable refusal is a claim the code cannot honour, and it would hide the
 * real reason behind a vaguer one.
 */
export function checkAssignment(
  profile: GuestProfile,
  repositoryId: string,
  referenceId: string,
): AssignmentRefusal | null {
  if (assignmentForRepository(profile, repositoryId)) return 'repository-already-dressed'

  const entry = ownedCompanions(profile).find((e) => e.referenceId === referenceId)
  if (!entry) return 'companion-not-owned'
  if (isSpent(profile, referenceId)) return 'companion-already-spent'

  return null
}

/**
 * Dress a repository, or explain why not.
 *
 * Never throws and never partially applies: either the returned profile has the
 * assignment or the original profile comes back untouched.
 */
export function assignCompanion(
  profile: GuestProfile,
  repositoryId: string,
  referenceId: string,
  now: string,
): AssignOutcome {
  const refusal = checkAssignment(profile, repositoryId, referenceId)
  if (refusal) return { ok: false, reason: refusal }

  const entry = ownedCompanions(profile).find((e) => e.referenceId === referenceId)
  // Unreachable after checkAssignment, but TypeScript needs the narrowing and a
  // silent `!` here would be the one place a bug could hide.
  if (!entry) return { ok: false, reason: 'companion-not-owned' }

  const assignment: RepoAssignment = {
    repositoryId,
    referenceId,
    companionId: entry.companionId,
    assignedAt: now,
  }

  return {
    ok: true,
    profile: {
      ...profile,
      updatedAt: now,
      assignmentsUpdatedAt: now,
      assignments: [...assignments(profile), assignment],
    },
  }
}

/** Undress one repository, freeing its companion for another. */
export function releaseRepository(
  profile: GuestProfile,
  repositoryId: string,
  now: string,
): GuestProfile {
  const kept = assignments(profile).filter((a) => a.repositoryId !== repositoryId)
  if (kept.length === assignments(profile).length) return profile
  return { ...profile, updatedAt: now, assignmentsUpdatedAt: now, assignments: kept }
}

/**
 * Drop assignments whose companion is no longer in the collection.
 *
 * A companion can only leave the collection if browser storage was edited by
 * hand or a restore replaced the profile. Either way, an assignment pointing at
 * something the user does not own would let them dress more repositories than
 * they have companions, so the orphans are dropped on read.
 */
export function pruneAssignments(profile: GuestProfile): GuestProfile {
  const owned = new Set(ownedCompanions(profile).map((e) => e.referenceId))
  const spent = new Set<string>()
  const kept = assignments(profile).filter((a) => {
    if (!owned.has(a.referenceId)) return false
    // Guard against a hand-edited profile that spends one companion twice.
    if (spent.has(a.referenceId)) return false
    spent.add(a.referenceId)
    return true
  })
  if (kept.length === assignments(profile).length) return profile
  return { ...profile, assignments: kept }
}
