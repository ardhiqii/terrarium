/**
 * `GET /api/auth/login` — start the GitHub OAuth flow.
 *
 * Mints a random `state`, stores it in a short-lived cookie, and redirects to
 * GitHub. `/api/auth/callback` compares the two.
 *
 * WHY STATE IS STORED IN A COOKIE rather than a server-side set: there is no
 * session to hang it off yet (that is the thing being established), and this
 * app deliberately has no shared server state. A cookie the browser echoes
 * back proves the callback landed in the same browser that started the flow,
 * which is exactly the property CSRF protection needs here.
 */

import { randomBytes } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { buildAuthorizeUrl, getOAuthConfig, resolveRedirectUri } from '@/lib/sync/github-oauth'
import {
  OAUTH_STATE_COOKIE,
  getSessionSecret,
  sessionCookieOptions,
} from '@/lib/sync/session-cookie'

// node:crypto, and a per-request redirect that must never be cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Ten minutes. A login the user abandons should not leave a live token behind. */
const STATE_MAX_AGE_SECONDS = 600

export async function GET(request: NextRequest): Promise<Response> {
  const config = getOAuthConfig()
  const secret = getSessionSecret()

  // Refuse to start a flow that cannot be finished. Without the signing key
  // the callback would authenticate the user correctly and then have no way
  // to issue a cookie, stranding them in a redirect loop that looks like a
  // GitHub problem rather than a missing environment variable.
  if (!config || !secret) {
    return new Response(
      JSON.stringify({
        error: 'GitHub sign in is not configured on this server.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }

  const state = randomBytes(32).toString('base64url')
  const redirectUri = resolveRedirectUri(request.nextUrl.origin)

  const response = NextResponse.redirect(
    buildAuthorizeUrl({ clientId: config.clientId, state, redirectUri })
  )
  response.cookies.set(OAUTH_STATE_COOKIE, state, sessionCookieOptions(STATE_MAX_AGE_SECONDS))
  return response
}
