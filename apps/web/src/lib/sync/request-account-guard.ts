/**
 * Optional client-side account proof for account-bound requests.
 *
 * The signed session remains the authority. This header only lets a delayed
 * request identify that it was started for a different account after a shared
 * browser profile changed accounts; it must never be used to choose the
 * account on the server.
 */

export const TERRARIUM_GITHUB_ID_HEADER = 'x-terrarium-github-id'

const GITHUB_ID_PATTERN = /^[1-9]\d*$/u

/**
 * Accept a missing header for older clients, but fail closed for every value
 * that is not the exact positive decimal GitHub id in the current session.
 */
export function requestAccountMatchesSession(
  request: Pick<Request, 'headers'> | undefined,
  githubId: number,
): boolean {
  const claimed = request?.headers.get(TERRARIUM_GITHUB_ID_HEADER)
  if (claimed === null || claimed === undefined) return true
  if (!GITHUB_ID_PATTERN.test(claimed)) return false
  const parsed = Number(claimed)
  return Number.isSafeInteger(parsed) && parsed === githubId
}
