/**
 * `GET /api/creature?user=<handle>`               -> that handle's CreatureState
 * `GET /api/creature?user=<handle>&repo=<name>`    -> that single repo's CreatureState
 *
 * The endpoint that makes the creature work for anyone, not just the site
 * owner. Read `AGENTS.md` and `tasks/T6.md` before touching this file: the
 * garden-asymmetry rule below is the highest-risk part of this codebase to
 * get wrong, since a mistake here ships to strangers, not just to us.
 *
 * THE GARDEN ASYMMETRY
 * `getCreatureState()` (state.ts, frozen behaviour, must-not-touch) always
 * computes garden stats from this repo's own local MDX content, because
 * that is genuinely the owner's garden. There is no version of that
 * function that is safe to call for an arbitrary handle: doing so would
 * hand every stranger the owner's note count, word count, and backlinks.
 * So this route branches explicitly:
 *   - `user` matches `GITHUB_LOGIN` (read from env, never hardcoded): call
 *     `getCreatureState(github)` directly. Real local garden stats, correct.
 *   - Any other `user`, and every `repo` creature: build the state via
 *     `composeCreatureState()` in `repo-creature.ts`, fed a fully zeroed
 *     `GardenStats`. Zeroed, not omitted, not borrowed.
 *
 * CACHING, the whole ballgame
 * 1. `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400` on
 *    every 200, so Vercel's edge (or any CDN in front of this) refreshes at
 *    most once an hour per exact URL and serves stale instantly meanwhile.
 * 2. An in-process cache (api-cache.ts) keyed by `user` (and `user/repo`),
 *    checked BEFORE any GitHub call is made. A fresh hit returns straight
 *    from that cache; nothing below it in this file executes, which is what
 *    makes "second identical request, zero GitHub calls" true.
 * 3. On a miss where GitHub itself fails (rate-limited, unreachable), a
 *    stale in-process entry is served over the network failure rather than
 *    falling straight to the zero-XP fallback, and the response is flagged
 *    `degraded: true` either way. Never a 500.
 *
 * `degraded` is an API-only addition, not part of the frozen `CreatureState`
 * shape; it is only ever present in this route's JSON body.
 */

import { NextRequest } from 'next/server'
import { fetchGithubStats } from '@/lib/game/github'
import { getCreatureState } from '@/lib/game/state'
import { getGardenStats } from '@/lib/game/stats'
import {
  composeCreatureState,
  emptyGardenStats,
  toRepoCommitStats,
} from '@/lib/game/repo-creature'
import { assignSpeciesLine } from '@/lib/game/species-assign'
import {
  cacheGetFresh,
  cacheGetStale,
  cacheSet,
  checkRateLimit,
} from '@/lib/game/api-cache'
import { CreatureState } from '@/lib/game/types'
import {
  HANDLE_RE,
  CACHE_TTL_MS,
  DISK_CACHE_MAX_AGE_MS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  isValidRepoName,
  getClientIp,
  corsHeaders,
  checkUserExists as checkUserExistsShared,
  checkRepoExists as checkRepoExistsShared,
  fetchRepoMeta,
  diskCachePathFor,
  readGardenRepoName,
} from '@/lib/game/creature-route-shared'

// Route handlers default to dynamic in this Next version (see
// node_modules/next/dist/docs/.../route.md, "Version History"). Made
// explicit here since this route deliberately manages its own caching via
// response headers plus the in-process store, rather than Next's data cache.
export const dynamic = 'force-dynamic'
// Uses node:fs / node:os for the per-handle disk cache below.
export const runtime = 'nodejs'

const OWNER_LOGIN = process.env.GITHUB_LOGIN
const TOKEN = process.env.GITHUB_TOKEN

const GARDEN_REPO_NAME = readGardenRepoName()

interface CachedPayload {
  status: number
  body: Record<string, unknown>
}

export async function GET(request: NextRequest): Promise<Response> {
  const ip = getClientIp(request)
  const rl = checkRateLimit(`ip:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  if (!rl.allowed) {
    return errorResponse(429, 'Rate limit exceeded. Try again shortly.')
  }

  const userParam = request.nextUrl.searchParams.get('user')
  const repoParam = request.nextUrl.searchParams.get('repo')

  if (!userParam) {
    return errorResponse(400, "Missing required query parameter 'user'.")
  }
  if (!HANDLE_RE.test(userParam)) {
    return errorResponse(400, "'user' is not a valid GitHub handle.")
  }
  if (repoParam !== null && !isValidRepoName(repoParam)) {
    return errorResponse(400, "'repo' is not a valid GitHub repository name.")
  }

  const cacheKey = repoParam
    ? `creature:${userParam.toLowerCase()}/${repoParam.toLowerCase()}`
    : `creature:${userParam.toLowerCase()}`

  // Cache check happens before anything that could touch the network. A
  // fresh hit returns here; no GitHub call is made anywhere below this line.
  const fresh = cacheGetFresh<CachedPayload>(cacheKey)
  if (fresh) {
    return jsonResponse(fresh.body, fresh.status, {
      ...cacheHeaders(fresh.status),
      'X-Cache': 'HIT',
    })
  }

  const result = repoParam
    ? await buildRepoResponse(userParam, repoParam, cacheKey)
    : await buildUserResponse(userParam, cacheKey)

  return jsonResponse(result.body, result.status, {
    ...cacheHeaders(result.status),
    'X-Cache': 'MISS',
  })
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

// ---------------------------------------------------------------------------
// Handle-level (garden) creature
// ---------------------------------------------------------------------------

async function buildUserResponse(
  user: string,
  cacheKey: string
): Promise<CachedPayload> {
  const isOwner =
    Boolean(OWNER_LOGIN) && user.toLowerCase() === OWNER_LOGIN!.toLowerCase()

  const existence = await checkUserExists(user)
  if (existence === 'not-found') {
    return {
      status: 404,
      body: { error: `GitHub user '${user}' was not found.` },
    }
  }

  const github = await fetchGithubStats({
    login: user,
    // Only the owner's own commits to this repo score at the higher
    // commit-to-garden rate. Every other handle passes no gardenRepo, so
    // gardenCommitsByDay comes back empty and computeCommitXp scores
    // everything at the flat rate.
    gardenRepo: isOwner ? GARDEN_REPO_NAME : undefined,
    token: TOKEN,
    cachePath: diskCachePathFor(user),
    maxAgeMs: DISK_CACHE_MAX_AGE_MS,
  })

  if (github === null) {
    return degradedOrFallback(cacheKey, () => {
      const stats = isOwner ? getGardenStats() : emptyGardenStats()
      return composeCreatureState(stats, null, { includeItems: true, isOwner })
    })
  }

  const state: CreatureState = isOwner
    ? getCreatureState(github)
    : composeCreatureState(emptyGardenStats(), github, {
        includeItems: true,
        isOwner: false,
      })

  const body = { ...state, degraded: false }
  cacheSet(cacheKey, { status: 200, body }, CACHE_TTL_MS)
  return { status: 200, body }
}

// ---------------------------------------------------------------------------
// Repo creature
// ---------------------------------------------------------------------------

async function buildRepoResponse(
  user: string,
  repo: string,
  cacheKey: string
): Promise<CachedPayload> {
  const userExistence = await checkUserExists(user)
  if (userExistence === 'not-found') {
    return {
      status: 404,
      body: { error: `GitHub user '${user}' was not found.` },
    }
  }

  const repoExistence = await checkRepoExists(user, repo)
  if (repoExistence === 'not-found') {
    return {
      status: 404,
      body: { error: `Repository '${user}/${repo}' was not found.` },
    }
  }

  const fetched = await fetchGithubStats({
    login: user,
    // The trick: asking github.ts for "this user's commits, with this repo
    // as the garden repo" makes gardenCommitsByDay come back as exactly
    // this repo's per-day commit activity. See toRepoCommitStats.
    gardenRepo: repo,
    token: TOKEN,
    cachePath: diskCachePathFor(user, repo),
    maxAgeMs: DISK_CACHE_MAX_AGE_MS,
  })

  if (fetched === null) {
    return degradedOrFallback(cacheKey, () =>
      composeCreatureState(emptyGardenStats(), null, {
        includeItems: true,
        isOwner: false,
      })
    )
  }

  const repoGithub = toRepoCommitStats(fetched, repo)
  // A repo creature never has a garden (see toRepoCommitStats), so it is
  // never "the owner" in the sense composeCreatureState cares about: it
  // only ever gets commit items, computed from this repo's own commit
  // activity, regardless of whose repo it is.
  const state = composeCreatureState(emptyGardenStats(), repoGithub, {
    includeItems: true,
    isOwner: false,
  })

  // SPECIES ASSIGNMENT (T19). `speciesLineId` is an API-only addition, same
  // pattern as `degraded` and `repo` above: not part of the frozen
  // `CreatureState` shape (see repo-creature.ts and species-assign.ts).
  // `fetchRepoMeta` reuses the same `/repos/{owner}/{repo}` endpoint
  // `checkRepoExists` already called above, so this never costs a second
  // kind of GitHub call, just a second (cached) hit of one already in use.
  // A failed metadata fetch still yields a deterministic assignment:
  // `assignSpeciesLine` treats a null language/age/size the same as any
  // other input, never throws, and never falls back to "no species."
  const meta = await fetchRepoMeta(user, repo, TOKEN, 'digital-garden-creature-api')
  const speciesLine = assignSpeciesLine({
    owner: user,
    repo,
    language: meta?.language ?? null,
    createdAt: meta?.createdAt ?? null,
    pushedAt: meta?.pushedAt ?? null,
    sizeKb: meta?.sizeKb ?? null,
  })

  const body = {
    ...state,
    degraded: false,
    repo,
    speciesLineId: speciesLine.id,
    speciesLineName: speciesLine.name,
  }
  cacheSet(cacheKey, { status: 200, body }, CACHE_TTL_MS)
  return { status: 200, body }
}

/**
 * Shared failure path for both handle and repo creatures: GitHub gave us
 * nothing usable (rate-limited, unreachable). Prefer a stale cached
 * response over the network failure; fall back to a stage-1, zero-XP
 * creature only when there is nothing cached at all. Always 200, always
 * `degraded: true`.
 */
async function degradedOrFallback(
  cacheKey: string,
  buildFallback: () => CreatureState
): Promise<CachedPayload> {
  const stale = cacheGetStale<CachedPayload>(cacheKey)
  if (stale) {
    return { status: stale.status, body: { ...stale.body, degraded: true } }
  }

  const fallback = buildFallback()
  const body = { ...fallback, degraded: true }
  cacheSet(cacheKey, { status: 200, body }, CACHE_TTL_MS)
  return { status: 200, body }
}

// ---------------------------------------------------------------------------
// Existence checks and disk-cache path resolution live in
// creature-route-shared.ts, imported above, so this route and
// api/creature.svg/route.ts can never compute different cache paths for the
// same handle.
// ---------------------------------------------------------------------------

async function checkUserExists(login: string) {
  return checkUserExistsShared(login, TOKEN, 'digital-garden-creature-api')
}

async function checkRepoExists(owner: string, repo: string) {
  return checkRepoExistsShared(owner, repo, TOKEN, 'digital-garden-creature-api')
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cacheHeaders(status: number): Record<string, string> {
  return {
    ...corsHeaders(),
    'Cache-Control':
      status === 200
        ? 'public, s-maxage=3600, stale-while-revalidate=86400'
        : 'no-store',
  }
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status, cacheHeaders(status))
}
