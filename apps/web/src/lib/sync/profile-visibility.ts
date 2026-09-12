/**
 * Privacy model for public profiles.
 *
 * PRODUCT.md's rule: a public profile is OPT-IN, and even then only aggregate
 * derived state is shown (XP, stage, companion counts) — never note titles,
 * contents, paths, or tags.
 *
 * The current `/u/[handle]` route renders ANY synced user's profile with no
 * opt-in gate, which is exactly the privacy hole this module closes. The
 * default must be PRIVATE: a profile stays hidden until its owner explicitly
 * opts in, and nothing about the profile leaks to the public route while it
 * is hidden.
 *
 * "Visibility" lives in the product sync store (a schema we own), not the
 * frozen legacy `SyncedSnapshot` shape. This module is the pure decision rule
 * so it is unit-testable without a UI, session, or network.
 */

export type ProfileVisibility = 'private' | 'public'

export interface ProfilePolicy {
  visibility: ProfileVisibility
  /** ISO timestamp the owner last changed visibility. */
  updatedAt: string
}

/** Stored per account in the product store. */
export interface ProfileVisibilityRecord {
  handle: string
  visibility: ProfileVisibility
  updatedAt: string
}

/** The default for any account that has never made an explicit choice. */
export const DEFAULT_VISIBILITY: ProfileVisibility = 'private'

/** The set of aggregate fields a public profile may expose. */
export const PUBLIC_PROFILE_FIELDS = [
  'handle',
  'avatarUrl',
  'totalXp',
  'stage',
  'stageIndex',
  'noteCount',
  'projectCount',
  'companionCount',
] as const

/** Everything that must NEVER appear on a public profile. */
export const NEVER_PUBLIC_FIELDS = [
  'guestId',
  'totalWords', // sensitive: leaks about private writing volume
  'tagCount', // tags are user-authored content
  'sourceBaselines',
  'events',
  'encounters',
  'collection',
  'recoverabilityWarning',
] as const

/**
 * Decide whether a public profile route may render for a given policy.
 * Any account that has not opted in is private. This is the single gate every
 * public surface must pass through, so a future caller cannot render a hidden
 * profile by forgetting to check.
 */
export function isProfilePublic(policy: ProfilePolicy | null): boolean {
  return policy?.visibility === 'public'
}

/** Create an opt-in record, flipping a profile on. Opting out is just removing it. */
export function optIn(handle: string, now: string): ProfileVisibilityRecord {
  return { handle: handle.toLowerCase(), visibility: 'public', updatedAt: now }
}

/** True when a given field name is allowed on a public profile. */
export function isPublicField(field: string): boolean {
  return (PUBLIC_PROFILE_FIELDS as readonly string[]).includes(field)
}

/** Normalize a parsed visibility value, defaulting anything unknown to PRIVATE. */
export function parseVisibility(value: unknown): ProfileVisibility {
  return value === 'public' ? 'public' : 'private'
}
