/**
 * `POST /api/auth/logout` — clear the session cookie.
 *
 * POST, not GET, and deliberately. A GET logout can be triggered by any page
 * that embeds `<img src="https://.../api/auth/logout">`, which is a small but
 * real griefing vector. Requiring POST means a cross-site request cannot do
 * it silently, and the `sameSite: 'lax'` cookie is not attached to a
 * cross-site POST anyway.
 *
 * Signing out is unconditional: it succeeds whether or not there was a
 * session, so a stale or corrupted cookie can always be cleared.
 */

import { NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@/lib/sync/session-cookie'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  const response = NextResponse.json({ signedIn: false })
  // Overwrite with an immediately-expiring cookie rather than only calling
  // delete(), so the attributes (path, secure, sameSite) match the ones the
  // cookie was set with. A mismatch there leaves the original in place and
  // the user cannot actually sign out.
  response.cookies.set(SESSION_COOKIE_NAME, '', sessionCookieOptions(0))
  return response
}
