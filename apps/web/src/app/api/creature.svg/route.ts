/**
 * `GET /api/creature.svg?user=<handle>`                    -> static SVG badge
 * `GET /api/creature.svg?user=<handle>&repo=<name>`         -> that repo's badge
 * `GET /api/creature.svg?user=<handle>&theme=dark`          -> dark-panel variant
 * `GET /api/creature.svg?user=<handle>&v=<anything>`        -> cache-busting, ignored server-side
 *
 * The README-embeddable fallback for anyone without the browser extension.
 * Read `AGENTS.md` and `docs/archive/tasks/T7.md` before touching this file.
 *
 * SHARED HELPERS. Existence checks, handle/repo validation regexes, the disk
 * cache path, and the garden repo name lookup live in
 * `apps/web/src/lib/game/creature-route-shared.ts` and are imported below rather than
 * reimplemented, so this route and `api/creature/route.ts` can never diverge
 * on where a given handle's disk cache lives (that divergence used to be a
 * real risk when both routes carried their own copy: it would have doubled
 * upstream GitHub calls for the same handle). The existence-check cache keys
 * (`exists:user:...`, `exists:repo:...`) and the disk cache directory are
 * shared with `api/creature/route.ts`, so the two routes share cache entries
 * in-process instead of doubling GitHub traffic.
 *
 * FAILURE BEHAVIOUR. This endpoint must never return a 500 or a JSON error
 * body: a broken image in someone's README is worse than a degraded one. See
 * `renderMessageSvg` / `renderCreatureBadgeSvg` in `svg-render.ts`. Every
 * branch below ends in a 200 with `Content-Type: image/svg+xml`.
 */

import { NextRequest } from 'next/server'
import { fetchGithubStats } from '@/lib/game/github'
import { getCreatureState } from '@/lib/game/state'
import { getGardenStats } from '@/lib/game/stats'
import {
  composeCreatureState,
  emptyGardenStats,
  toRepoCommitStats,
  fallbackCreatureState,
} from '@/lib/game/repo-creature'
import {
  cacheGetFresh,
  cacheGetStale,
  cacheSet,
  checkRateLimit,
} from '@/lib/game/api-cache'
import { getSprite } from '@/lib/game/sprites'
import { STAGES } from '@/lib/game/types'
import type { CreatureState } from '@/lib/game/types'
import {
  renderCreatureBadgeSvg,
  renderMessageSvg,
  resolveTheme,
} from '@/lib/game/svg-render'
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
  diskCachePathFor,
  readGardenRepoName,
} from '@/lib/game/creature-route-shared'

// Route handlers default to dynamic in this Next version (see
// node_modules/next/dist/docs/.../route.md, "Version History"). Made
// explicit since this route manages its own caching via response headers
// plus the in-process store, rather than Next's data cache.
export const dynamic = 'force-dynamic'
// Uses node:fs / node:os for the per-handle disk cache below.
export const runtime = 'nodejs'

const OWNER_LOGIN = process.env.GITHUB_LOGIN
const TOKEN = process.env.GITHUB_TOKEN

const GARDEN_REPO_NAME = readGardenRepoName()

export async function GET(request: NextRequest): Promise<Response> {
  const ip = getClientIp(request)
  const theme = resolveTheme(request.nextUrl.searchParams.get('theme'))

  const rl = checkRateLimit(`svg-ip:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  if (!rl.allowed) {
    return svgResponse(renderMessageSvg('Rate limit exceeded, try again shortly.', theme), 200)
  }

  const userParam = request.nextUrl.searchParams.get('user')
  const repoParam = request.nextUrl.searchParams.get('repo')

  if (!userParam) {
    return svgResponse(renderMessageSvg('user parameter required', theme), 200)
  }
  if (!HANDLE_RE.test(userParam)) {
    return svgResponse(renderMessageSvg('user is not a valid GitHub handle', theme), 200)
  }
  if (repoParam !== null && !isValidRepoName(repoParam)) {
    return svgResponse(renderMessageSvg('repo is not a valid repository name', theme), 200)
  }

  try {
    const state = repoParam
      ? await resolveRepoState(userParam, repoParam)
      : await resolveUserState(userParam)

    if (state.kind === 'not-found') {
      return svgResponse(renderMessageSvg(state.message, theme), 200)
    }

    const stage = state.creature.stage
    const sprite = getSprite(stage.id)
    if (!sprite) {
      // Should be unreachable: every StageId has a code-generated sprite.
      // Guard anyway, per the "always renderable" contract.
      return svgResponse(
        renderMessageSvg('creature sprite unavailable', theme),
        200
      )
    }

    const svg = renderCreatureBadgeSvg({
      sprite,
      stage,
      stageCount: STAGES.length,
      totalXp: state.creature.totalXp,
      xpIntoStage: state.creature.xpIntoStage,
      xpForNextStage: state.creature.xpForNextStage,
      progress: state.creature.progress,
      handle: userParam,
      repo: repoParam,
      degraded: state.degraded,
      theme,
    })

    return svgResponse(svg, 200)
  } catch {
    // Absolute last resort. Every function above already has its own
    // never-throws contract, but this route's own promise is stronger than
    // any of theirs: it must always return a renderable SVG, so one more
    // guard sits at the top level.
    const fallback = fallbackCreatureState(false)
    const sprite = getSprite(fallback.stage.id)
    if (!sprite) {
      return svgResponse(renderMessageSvg('creature temporarily unavailable', theme), 200)
    }
    const svg = renderCreatureBadgeSvg({
      sprite,
      stage: fallback.stage,
      stageCount: STAGES.length,
      totalXp: fallback.totalXp,
      xpIntoStage: fallback.xpIntoStage,
      xpForNextStage: fallback.xpForNextStage,
      progress: fallback.progress,
      handle: userParam,
      repo: repoParam,
      degraded: true,
      theme,
    })
    return svgResponse(svg, 200)
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

// ---------------------------------------------------------------------------
// State resolution, mirroring api/creature/route.ts's shape and the same
// garden-asymmetry rule: only the configured GITHUB_LOGIN gets its real
// local garden stats, every other handle (and every repo) gets zeroed
// GardenStats plus that handle's own commit data. See repo-creature.ts.
// ---------------------------------------------------------------------------

type ResolvedState =
  | { kind: 'ok'; creature: CreatureState; degraded: boolean }
  | { kind: 'not-found'; message: string }

async function resolveUserState(user: string): Promise<ResolvedState> {
  const cacheKey = `svgstate:${user.toLowerCase()}`
  const fresh = cacheGetFresh<ResolvedState>(cacheKey)
  if (fresh) return fresh

  const isOwner =
    Boolean(OWNER_LOGIN) && user.toLowerCase() === OWNER_LOGIN!.toLowerCase()

  const existence = await checkUserExists(user)
  if (existence === 'not-found') {
    return { kind: 'not-found', message: `GitHub user '${user}' was not found` }
  }

  const github = await fetchGithubStats({
    login: user,
    gardenRepo: isOwner ? GARDEN_REPO_NAME : undefined,
    token: TOKEN,
    cachePath: diskCachePathFor(user),
    maxAgeMs: DISK_CACHE_MAX_AGE_MS,
  })

  if (github === null) {
    const result = degradedOrFallback(cacheKey, () => {
      // Local garden stats are only ever safe to use for the owner's own
      // handle; every other handle gets the zeroed stats, same rule T6 uses.
      const stats = isOwner ? getGardenStats() : emptyGardenStats()
      return composeCreatureState(stats, null, { includeItems: false })
    })
    cacheSet(cacheKey, result, CACHE_TTL_MS)
    return result
  }

  const creature: CreatureState = isOwner
    ? getCreatureState(github)
    : composeCreatureState(emptyGardenStats(), github, { includeItems: false })

  const result: ResolvedState = { kind: 'ok', creature, degraded: false }
  cacheSet(cacheKey, result, CACHE_TTL_MS)
  return result
}

async function resolveRepoState(user: string, repo: string): Promise<ResolvedState> {
  const cacheKey = `svgstate:${user.toLowerCase()}/${repo.toLowerCase()}`
  const fresh = cacheGetFresh<ResolvedState>(cacheKey)
  if (fresh) return fresh

  const userExistence = await checkUserExists(user)
  if (userExistence === 'not-found') {
    return { kind: 'not-found', message: `GitHub user '${user}' was not found` }
  }

  const repoExistence = await checkRepoExists(user, repo)
  if (repoExistence === 'not-found') {
    return { kind: 'not-found', message: `Repository '${user}/${repo}' was not found` }
  }

  const fetched = await fetchGithubStats({
    login: user,
    gardenRepo: repo,
    token: TOKEN,
    cachePath: diskCachePathFor(user, repo),
    maxAgeMs: DISK_CACHE_MAX_AGE_MS,
  })

  if (fetched === null) {
    const result = degradedOrFallback(cacheKey, () =>
      composeCreatureState(emptyGardenStats(), null, { includeItems: false })
    )
    cacheSet(cacheKey, result, CACHE_TTL_MS)
    return result
  }

  const repoGithub = toRepoCommitStats(fetched, repo)
  const creature = composeCreatureState(emptyGardenStats(), repoGithub, {
    includeItems: false,
  })

  const result: ResolvedState = { kind: 'ok', creature, degraded: false }
  cacheSet(cacheKey, result, CACHE_TTL_MS)
  return result
}

/**
 * GitHub gave us nothing usable (rate-limited, unreachable). Prefer a stale
 * cached response over the network failure; fall back to a stage-1, zero-XP
 * creature (T6's own fallback shape, reused via `fallbackCreatureState`)
 * only when there is nothing cached at all. Always `degraded: true`.
 */
function degradedOrFallback(
  cacheKey: string,
  buildFallback: () => CreatureState
): ResolvedState {
  const stale = cacheGetStale<ResolvedState>(cacheKey)
  if (stale && stale.kind === 'ok') {
    return { kind: 'ok', creature: stale.creature, degraded: true }
  }
  return { kind: 'ok', creature: buildFallback(), degraded: true }
}

// ---------------------------------------------------------------------------
// Existence checks, imported from creature-route-shared.ts, share
// api/creature/route.ts's cache key namespace.
// ---------------------------------------------------------------------------

async function checkUserExists(login: string) {
  return checkUserExistsShared(login, TOKEN, 'terrarium-creature-svg')
}

async function checkRepoExists(owner: string, repo: string) {
  return checkRepoExistsShared(owner, repo, TOKEN, 'terrarium-creature-svg')
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function svgResponse(svg: string, status: number): Response {
  return new Response(svg, {
    status,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // Camo (GitHub's README image proxy) caches aggressively. `s-maxage`
      // matches the in-process TTL above; `stale-while-revalidate` lets a
      // stale badge keep serving instantly while a fresh one is computed.
      // The `v` query param (accepted, never read server-side) lets a README
      // author force camo to refetch by changing the URL.
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      ...corsHeaders(),
    },
  })
}

