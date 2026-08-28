/**
 * `GET /api/auth/session` — who, if anyone, is signed in.
 *
 * THIS ENDPOINT EXISTS TO KEEP THE SITE STATIC. The Navbar needs to know
 * whether to show the Leaderboard link and a sign out control. Reading the
 * session in `app/layout.tsx` would be the obvious way to do that, but
 * `cookies()` is a request-time API, and per the Next 16 docs "using it in a
 * layout or page will opt a route into dynamic rendering". In a root layout
 * that means every page in the site, so all 38 prerendered routes would
 * become server-rendered to decide the visibility of one nav link. Fetching
 * it from the client instead keeps the notes, projects, and tag pages static.
 *
 * The trade is a brief moment after load where the nav has not resolved yet.
 * That is why the response is deliberately tiny and uncached.
 *
 * NEVER CACHE THIS. A cached response here would serve one visitor's identity
 * to the next, which is the single worst bug this file could have. Hence
 * `force-dynamic` plus explicit no-store.
 */

import { getSessionProvider, isOAuthConfigured } from '@/lib/sync/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const session = await getSessionProvider().current()

  // `configured` lets the Navbar hide the sign in control entirely on a
  // deployment with no OAuth app, rather than offering a button that can
  // only ever answer 503.
  const configured = isOAuthConfigured()

  // Only what the nav actually renders. The numeric GitHub id is part of
  // `Session` but nothing client-side needs it, so it does not leave here.
  const body = session
    ? { signedIn: true, handle: session.handle, avatarUrl: session.avatarUrl, configured }
    : { signedIn: false, handle: null, avatarUrl: null, configured }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
    },
  })
}
