/**
 * `GET /api/auth/callback` — finish the GitHub OAuth flow.
 *
 * GitHub redirects the browser here with `code` and `state`. This route
 * verifies the state, trades the code for a token, reads the token owner's
 * identity, issues our own signed session cookie, and drops the token.
 *
 * THE STATE CHECK IS THE SECURITY BOUNDARY OF THIS FILE. Without it, an
 * attacker completes a login as themselves, keeps the resulting `code`, and
 * feeds a victim a link to this endpoint carrying it. The victim's browser
 * would then be issued a cookie for the *attacker's* account, and anything
 * the victim went on to sync would land in the attacker's row. Comparing
 * against a cookie set at `/api/auth/login` proves the callback belongs to a
 * flow this browser actually started.
 *
 * FAILURES REDIRECT, THEY DO NOT RENDER ERRORS. Whatever goes wrong here, the
 * user is a person who clicked "sign in", so they end up back on the site
 * signed out rather than looking at a JSON blob. `?signin=failed` is there so
 * the UI can say something honest.
 */

import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  exchangeCodeForToken,
  fetchGithubIdentity,
  getOAuthConfig,
  resolveRedirectUri,
} from '@/lib/sync/github-oauth'
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE_NAME,
  encodeSessionCookie,
  getSessionSecret,
  sessionCookieOptions,
} from '@/lib/sync/session-cookie'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Constant-time comparison of two state values.
 *
 * `timingSafeEqual` throws on a length mismatch, which is the ordinary case
 * for a missing or truncated cookie, so length is checked first.
 */
function statesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.byteLength !== bufB.byteLength) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Send the user home, signed out, and always clear the one-shot state cookie
 * so a failed attempt cannot be replayed.
 */
function failed(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL('/?signin=failed', request.nextUrl.origin))
  response.cookies.delete(OAUTH_STATE_COOKIE)
  return response
}

export async function GET(request: NextRequest): Promise<Response> {
  const config = getOAuthConfig()
  const secret = getSessionSecret()
  if (!config || !secret) return failed(request)

  const params = request.nextUrl.searchParams

  // The user pressed "Cancel" on GitHub's authorize screen. Not an error
  // worth surfacing as one; just put them back where they started.
  if (params.get('error')) {
    const response = NextResponse.redirect(new URL('/', request.nextUrl.origin))
    response.cookies.delete(OAUTH_STATE_COOKIE)
    return response
  }

  const code = params.get('code')
  const state = params.get('state')
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value

  if (!code || !state || !expectedState) return failed(request)
  if (!statesMatch(state, expectedState)) return failed(request)

  const redirectUri = resolveRedirectUri(request.nextUrl.origin)
  const token = await exchangeCodeForToken(code, config, redirectUri)
  if (!token) return failed(request)

  const identity = await fetchGithubIdentity(token)
  if (!identity) return failed(request)

  // The token has now done its entire job. It is not stored anywhere, which
  // is why the app does not care whether GitHub expires it.
  const response = NextResponse.redirect(new URL('/', request.nextUrl.origin))
  response.cookies.set(
    SESSION_COOKIE_NAME,
    encodeSessionCookie(identity, secret),
    sessionCookieOptions()
  )
  response.cookies.delete(OAUTH_STATE_COOKIE)
  return response
}
