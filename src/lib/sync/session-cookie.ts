/**
 * The signed session cookie: how a browser proves who it is after the GitHub
 * OAuth round trip has finished.
 *
 * SIGNED, NOT ENCRYPTED, and that is deliberate. The payload holds a GitHub
 * handle, a numeric id, and an avatar URL, all of which are already public on
 * github.com. There is nothing here worth hiding from the person the cookie
 * belongs to. What actually matters is that they cannot *edit* it, because
 * `api/sync` takes the handle from the session and never from the request
 * body (see the header of `src/app/api/sync/route.ts`). A forged handle would
 * therefore let anyone overwrite anyone else's row, so integrity is the whole
 * job and an HMAC is the right tool for it.
 *
 * WHY NOT A JWT LIBRARY. This is one HMAC over one small JSON object with a
 * single hardcoded algorithm. A JWT brings an `alg` header field, and the
 * classic attack on that field is talking a verifier into accepting `none`.
 * There is no algorithm negotiation here at all: verification recomputes
 * HMAC-SHA256 and compares, so that class of bug cannot be expressed.
 *
 * No `node:crypto` import may ever reach a client bundle. Everything here is
 * server-only and is imported only by route handlers and `session.ts`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Session } from './types'

export const SESSION_COOKIE_NAME = 'tg_session'

/** Thirty days. Long enough to feel persistent, short enough to age out. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/**
 * Holds the OAuth `state` between `/api/auth/login` and `/api/auth/callback`.
 *
 * It lives here rather than in either route because both need it, and a
 * `route.ts` is not a safe place to export a shared constant from: Next
 * type-checks those files against a fixed set of allowed exports.
 */
export const OAUTH_STATE_COOKIE = 'tg_oauth_state'

/**
 * Rejecting a short secret is not pedantry. An HMAC is only as strong as its
 * key, and the failure mode of a weak one is silent: everything still works,
 * and forgery is merely cheap. Refusing to sign at all is louder and safer.
 */
const MIN_SECRET_LENGTH = 32

/** Deliberately terse keys: this string rides on every single request. */
interface CookiePayload {
  /** handle */
  h: string
  /** githubId */
  i: number
  /** avatarUrl */
  a: string | null
  /** expiry, epoch seconds */
  exp: number
}

/**
 * The signing key, or null when it is missing or too short. Null is a real
 * answer here rather than a thrown error, so a misconfigured deployment
 * degrades to signed-out (see `session.ts`) instead of failing every render.
 */
export function getSessionSecret(): string | null {
  const raw = process.env.SESSION_SECRET
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length < MIN_SECRET_LENGTH) return null
  return trimmed
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

/**
 * Constant-time signature comparison.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, which is
 * exactly what an attacker probing with truncated signatures would produce,
 * so the length check comes first and returns rather than throwing.
 */
function signaturesMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Serialise a session into `<payload>.<signature>`, both base64url.
 *
 * `now` is injectable purely so tests can produce an already-expired cookie
 * without waiting thirty days.
 */
export function encodeSessionCookie(
  session: Session,
  secret: string,
  now: number = nowSeconds()
): string {
  const payload: CookiePayload = {
    h: session.handle,
    i: session.githubId,
    a: session.avatarUrl,
    exp: now + SESSION_MAX_AGE_SECONDS,
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${body}.${sign(body, secret)}`
}

/**
 * Verify and parse a cookie value. Null for every failure: wrong shape, bad
 * signature, unparseable JSON, wrong field types, or expired.
 *
 * ORDER MATTERS. The signature is checked before the payload is parsed, so
 * untrusted bytes never reach `JSON.parse` unless they were signed by us.
 */
export function decodeSessionCookie(
  raw: string | undefined | null,
  secret: string,
  now: number = nowSeconds()
): Session | null {
  if (!raw) return null

  const parts = raw.split('.')
  if (parts.length !== 2) return null
  const [body, signature] = parts
  if (!body || !signature) return null

  if (!signaturesMatch(sign(body, secret), signature)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const { h, i, a, exp } = parsed as Partial<CookiePayload>

  if (typeof h !== 'string' || h.length === 0) return null
  if (typeof i !== 'number' || !Number.isFinite(i)) return null
  if (a !== null && typeof a !== 'string') return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  if (exp <= now) return null

  return { handle: h, githubId: i, avatarUrl: a }
}

/**
 * Cookie attributes, shared by the routes that set and clear the session so
 * the two can never drift (a `delete` that disagrees with the `set` on `path`
 * silently leaves the original cookie in place, and the user cannot sign out).
 *
 * `sameSite: 'lax'` is required, not a preference: the browser arrives at the
 * callback via a top-level redirect from github.com, and `strict` would
 * withhold the cookie on exactly that navigation.
 */
export function sessionCookieOptions(maxAge: number = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  }
}
