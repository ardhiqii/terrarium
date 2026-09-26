/**
 * Where the browser goes after GitHub authorization.
 *
 * The callback used to land on `/` unconditionally, which threw away the page
 * the user actually came from: authorizing from `/github` dropped them on the
 * home page with no way back to what they were doing.
 *
 * ONLY a same-origin relative path is ever accepted. An unvalidated return path
 * is an open redirect: `?next=//evil.example` and `?next=https://evil.example`
 * both send a freshly authorized visitor to another site. The value also
 * round-trips through a cookie, so it is re-validated at every hop rather than
 * trusted once.
 *
 * Deliberately pure and free of Node built-ins: `'use client'` components import
 * it to build the sign-in link, and the guard test at
 * `client-bundle-safety.test.ts` covers that.
 */

/** Where a sign-in lands when no usable return path was supplied. */
export const DEFAULT_RETURN_PATH = '/'

/** Upper bound on a return path, to bound the cookie that stores it. */
const MAX_RETURN_PATH_LENGTH = 512

/**
 * Reduce any input to a safe same-origin path, or {@link DEFAULT_RETURN_PATH}.
 *
 * Rejected: absolute URLs, protocol-relative `//host` paths and the `/\host`
 * variant that browsers normalise to the same thing, backslashes, control
 * characters that could split a response header, and anything that does not
 * begin with a single `/`.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_RETURN_PATH
  const candidate = value.trim()
  if (candidate.length === 0 || candidate.length > MAX_RETURN_PATH_LENGTH) return DEFAULT_RETURN_PATH
  if (!candidate.startsWith('/')) return DEFAULT_RETURN_PATH
  // `//host` and `/\host` are both resolved as absolute by browsers.
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return DEFAULT_RETURN_PATH
  if (candidate.includes('\\')) return DEFAULT_RETURN_PATH
  // Control characters would allow a header split in the Location value.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(candidate)) return DEFAULT_RETURN_PATH
  return candidate
}

/**
 * The sign-in href that returns the user to `path` once authorization
 * completes. Falls back to the bare endpoint when the path is unusable, so a
 * bad value can never widen the link.
 */
export function loginHrefFor(path: unknown): string {
  const safe = safeReturnPath(path)
  return safe === DEFAULT_RETURN_PATH
    ? '/api/auth/login'
    : `/api/auth/login?next=${encodeURIComponent(safe)}`
}
