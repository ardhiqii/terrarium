/** Pure helpers for account-bound browser requests. */

export const TERRARIUM_GITHUB_ID_HEADER = 'X-Terrarium-GitHub-Id'
export const ACCOUNT_CHANGED_RELOAD_MESSAGE = 'The GitHub account changed while this page was open. Reload the source and try again.'

/** Capture the immutable account ID on the request rather than reading it from
 * mutable React state after an async operation has started. */
export function githubAccountHeaders(
  githubId: number,
  additional: Readonly<Record<string, string>> = {},
): Record<string, string> {
  if (!Number.isSafeInteger(githubId) || githubId <= 0) {
    throw new TypeError('A GitHub account ID must be a positive safe integer')
  }
  return {
    ...additional,
    [TERRARIUM_GITHUB_ID_HEADER]: String(githubId),
  }
}

function accountChangedString(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return value.trim().toLowerCase().replace(/[\s-]+/gu, '_') === 'account_changed'
}

/** Accept the small error contract used by account-bound API routes. */
export function isAccountChangedBody(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return body.accountChanged === true ||
    accountChangedString(body.error) ||
    accountChangedString(body.code) ||
    accountChangedString(body.reason)
}

export function isAccountChangedError(error: unknown): boolean {
  return error instanceof Error && accountChangedString(error.message)
}
