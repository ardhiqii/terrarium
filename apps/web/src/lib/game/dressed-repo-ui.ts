/**
 * The pure decisions behind the dressed-repo rows on `/repos`
 * (docs-plan/PLAN-dressed-repo-qa-fixes.md, fixes 1 and 4).
 *
 * Kept out of `CompanionPicker.tsx` so they are unit-tested in the node
 * environment (the suite has no DOM). Pure strings and data only: a client
 * component imports this, so it must never reach a Node built-in.
 */

/** The fields of an assignment that decide whether the server matches the browser. */
export interface AssignmentKey {
  readonly repositoryId: string
  readonly referenceId: string
}

/**
 * Where the server copy of the dressing stands.
 *   - `unknown`: not read yet.
 *   - `error`: the read or the last push failed; a push can fix it.
 *   - `never-synced`: the account has no stored snapshot; the first sync on
 *     `/github` must create it.
 *   - `other-profile`: the stored snapshot belongs to a different local profile.
 *   - `saving`: a push is in flight.
 *   - `ready`: `server` holds what the server has.
 */
export type ServerDressing =
  | { readonly status: 'unknown' | 'never-synced' | 'other-profile' | 'saving' | 'error' }
  | { readonly status: 'ready'; readonly server: readonly AssignmentKey[] }

function keyOf(assignment: AssignmentKey): string {
  return `${assignment.repositoryId}|${assignment.referenceId}`
}

/** Same set of (repository, companion) pairs, order ignored. */
export function assignmentsInSync(
  local: readonly AssignmentKey[],
  server: readonly AssignmentKey[],
): boolean {
  if (local.length !== server.length) return false
  const serverKeys = new Set(server.map(keyOf))
  return local.every((assignment) => serverKeys.has(keyOf(assignment)))
}

export type DressedRowState =
  /** Badge setting off: say nothing about GitHub. */
  | 'local'
  /** The server copy has not been read yet. */
  | 'checking'
  | 'private'
  | 'shown'
  | 'saving'
  /** Not on the server yet, and a push can fix it: offer a retry. */
  | 'not-on-github'
  /** No stored snapshot: only the full sync on `/github` can fix it. */
  | 'needs-first-sync'
  | 'other-profile'

export function dressedRowState(input: {
  readonly badgesOn: boolean
  readonly isPrivate: boolean
  readonly assignment: AssignmentKey
  readonly dressing: ServerDressing
}): DressedRowState {
  if (!input.badgesOn) return 'local'
  if (input.isPrivate) return 'private'
  switch (input.dressing.status) {
    case 'unknown':
      return 'checking'
    case 'saving':
      return 'saving'
    case 'never-synced':
      return 'needs-first-sync'
    case 'other-profile':
      return 'other-profile'
    case 'ready':
      return input.dressing.server.some((entry) => keyOf(entry) === keyOf(input.assignment))
        ? 'shown'
        : 'not-on-github'
    default:
      return 'not-on-github'
  }
}

/** The short suffix after "dressed by X" in a row. */
export const DRESSED_ROW_SUFFIX: Readonly<Record<DressedRowState, string>> = {
  local: '',
  checking: ' · checking…',
  private: ' · private, not shown',
  shown: ' · shown on GitHub',
  saving: ' · saving…',
  'not-on-github': ' · not on GitHub yet',
  'needs-first-sync': ' · sync once on GitHub first',
  'other-profile': ' · synced from another profile',
}

/** What the picker says when there are no repositories to list. */
export type RepoEmptyState = 'sign-in' | 'pick-repos'

export function repoEmptyState(signedIn: boolean): RepoEmptyState {
  return signedIn ? 'pick-repos' : 'sign-in'
}
