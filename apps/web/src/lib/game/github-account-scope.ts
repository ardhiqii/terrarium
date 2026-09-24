/**
 * Immutable account-namespace gate used by the GitHub source panel.
 *
 * The repository listing identifies an account before its browser namespace is
 * safe to use. Hydration can be delayed, and a second response can identify a
 * different account while the first account's cloud read is still in flight.
 * This reducer gives the panel a small, deterministic commit token: only the
 * latest token can make a namespace writable.
 */

export interface AccountNamespaceGate {
  readonly generation: number
  readonly githubId: number | null
  readonly namespace: string | null
  readonly hydrated: boolean
}

export interface AccountHydrationToken {
  readonly generation: number
  readonly githubId: number
  readonly namespace: string
}

export type HydratedAccountNamespace = AccountHydrationToken

export function createAccountNamespaceGate(): AccountNamespaceGate {
  return {
    generation: 0,
    githubId: null,
    namespace: null,
    hydrated: false,
  }
}

export function accountNamespaceForGithubId(githubId: number): string {
  if (!Number.isSafeInteger(githubId) || githubId < 0) {
    throw new TypeError('A GitHub account ID must be a non-negative safe integer')
  }
  return `github-${githubId}`
}

/** Start a new account read and invalidate every previously captured scope. */
export function beginAccountHydration(
  gate: AccountNamespaceGate,
  githubId: number,
): { readonly gate: AccountNamespaceGate; readonly token: AccountHydrationToken } {
  const namespace = accountNamespaceForGithubId(githubId)
  const generation = gate.generation + 1
  return {
    gate: {
      generation,
      githubId,
      namespace,
      hydrated: false,
    },
    token: { generation, githubId, namespace },
  }
}

/** Invalidate a scope when the session/account response is no longer usable. */
export function invalidateAccountNamespace(gate: AccountNamespaceGate): AccountNamespaceGate {
  return {
    generation: gate.generation + 1,
    githubId: null,
    namespace: null,
    hydrated: false,
  }
}

/**
 * Commit a hydration only if no newer account read has started. A stale
 * response gets no scope and therefore cannot authorize a browser write.
 */
export function commitAccountHydration(
  gate: AccountNamespaceGate,
  token: AccountHydrationToken,
): { readonly gate: AccountNamespaceGate; readonly scope: HydratedAccountNamespace | null } {
  if (
    gate.generation !== token.generation ||
    gate.githubId !== token.githubId ||
    gate.namespace !== token.namespace ||
    gate.hydrated
  ) {
    return { gate, scope: null }
  }

  const next: AccountNamespaceGate = {
    generation: token.generation,
    githubId: token.githubId,
    namespace: token.namespace,
    hydrated: true,
  }
  return {
    gate: next,
    scope: { ...token },
  }
}

export function hydratedAccountNamespace(
  gate: AccountNamespaceGate,
): HydratedAccountNamespace | null {
  if (!gate.hydrated || gate.githubId === null || gate.namespace === null) return null
  return {
    generation: gate.generation,
    githubId: gate.githubId,
    namespace: gate.namespace,
  }
}

/** True only for the immutable scope that was committed most recently. */
export function isCurrentAccountNamespace(
  gate: AccountNamespaceGate,
  scope: HydratedAccountNamespace,
): boolean {
  return gate.hydrated &&
    gate.generation === scope.generation &&
    gate.githubId === scope.githubId &&
    gate.namespace === scope.namespace
}
