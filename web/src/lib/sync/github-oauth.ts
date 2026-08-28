/**
 * The GitHub OAuth web flow, as pure functions. No cookies, no redirects, no
 * Next.js: those live in `src/app/api/auth/*`, so everything here is directly
 * testable against a stubbed `fetch`.
 *
 * REGISTERED AS A GITHUB APP, not an OAuth App. For user login the two speak
 * the same protocol and the same endpoints, and the difference that matters
 * here is that a GitHub App accepts several callback URLs, so localhost and
 * the deployed origin can coexist without re-registering.
 *
 * NO SCOPES ARE REQUESTED. Identity (`login`, `id`, `avatar_url`) comes back
 * from `GET /user` on a bare user token, the friends list is public data read
 * with the server's own token in `github-following.ts`, and commit activity
 * is public too. The app therefore asks for no repository, organization, or
 * account permissions at all. If a future feature seems to need a scope, that
 * is a decision worth making loudly rather than by quietly widening this.
 *
 * THE ACCESS TOKEN IS NEVER STORED. It is exchanged, used once to read the
 * user's identity, and dropped. What persists is our own signed session
 * cookie (`session-cookie.ts`). This is why token expiry does not matter and
 * why there is no refresh path to maintain.
 *
 * Standing rule, same as everywhere else that touches the network: every
 * failure path returns null rather than throwing.
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_API_BASE = 'https://api.github.com'
const FETCH_TIMEOUT_MS = 10_000

export interface OAuthConfig {
  clientId: string
  clientSecret: string
}

/**
 * Credentials from the environment, or null when either is absent.
 *
 * Null is what `session.ts` keys off to decide that OAuth is simply not
 * configured, which is the correct state for a checkout that has never
 * registered an app. It must not be an error.
 */
export function getOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim()
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

/**
 * Where to send the browser to start the flow.
 *
 * `state` is the CSRF defence and is not optional: without it, an attacker
 * can hand a victim a callback URL carrying the attacker's own `code` and
 * log the victim into the attacker's account. The caller generates it, stores
 * it in a short-lived cookie, and compares on the way back.
 */
export function buildAuthorizeUrl(params: {
  clientId: string
  state: string
  redirectUri: string
}): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('state', params.state)
  url.searchParams.set('redirect_uri', params.redirectUri)
  return url.toString()
}

/**
 * The callback URL, which must match one of the app's registered entries
 * byte for byte or GitHub refuses the exchange.
 *
 * Derived from the request's own origin so localhost and the deployed site
 * both work with no configuration. `AUTH_BASE_URL` overrides it for the one
 * case where the origin lies: behind a proxy or tunnel that terminates TLS,
 * where the app sees `http://internal:3000` and the browser saw HTTPS.
 */
export function resolveRedirectUri(origin: string): string {
  const override = process.env.AUTH_BASE_URL?.trim()
  const base = override && override.length > 0 ? override : origin
  return `${base.replace(/\/+$/, '')}/api/auth/callback`
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Trade the one-time `code` for a user access token. Null on any failure.
 *
 * GitHub answers this endpoint with HTTP 200 even when it is reporting an
 * error, putting `{ "error": "bad_verification_code" }` in the body, so
 * checking the status alone would treat a rejected code as a success and
 * carry `undefined` forward as a token. The body is what decides.
 */
export async function exchangeCodeForToken(
  code: string,
  config: OAuthConfig,
  redirectUri: string
): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    })

    if (!response.ok) return null

    const raw: unknown = await response.json()
    if (typeof raw !== 'object' || raw === null) return null

    const token = (raw as Record<string, unknown>).access_token
    if (typeof token !== 'string' || token.length === 0) return null
    return token
  } catch {
    return null
  }
}

/** The identity fields, and only those, that a `Session` is built from. */
export interface GithubIdentity {
  handle: string
  githubId: number
  avatarUrl: string | null
}

/**
 * Read the token owner's public identity. Null on any failure.
 *
 * The handle is lowercased here rather than at the call site because it is
 * the primary key in `SyncStore` and GitHub logins are case-insensitive.
 * Doing it once, at the boundary where the value enters the system, is what
 * stops `Torvalds` and `torvalds` becoming two rows.
 */
export async function fetchGithubIdentity(
  token: string,
  apiBase: string = DEFAULT_API_BASE
): Promise<GithubIdentity | null> {
  try {
    const response = await fetchWithTimeout(`${apiBase}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'terrarium-garden',
      },
    })

    if (!response.ok) return null

    const raw: unknown = await response.json()
    if (typeof raw !== 'object' || raw === null) return null

    const record = raw as Record<string, unknown>
    const login = record.login
    const id = record.id
    const avatarUrl = record.avatar_url

    if (typeof login !== 'string' || login.length === 0) return null
    if (typeof id !== 'number' || !Number.isFinite(id)) return null

    return {
      handle: login.toLowerCase(),
      githubId: id,
      avatarUrl: typeof avatarUrl === 'string' && avatarUrl.length > 0 ? avatarUrl : null,
    }
  } catch {
    return null
  }
}
