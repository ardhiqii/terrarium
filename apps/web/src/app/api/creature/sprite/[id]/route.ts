/**
 * `GET /api/creature/sprite/<item-id>` -> that item's `SpriteData` as JSON.
 *
 * GAP 2 FROM docs/archive/tasks/T9.md: `CreatureState.items[].def.sprite` (frozen shape,
 * `types.ts`) is a bare id string. The extension has no access to
 * `SpriteData`, so its popup would otherwise render items as text pills
 * instead of pixel art.
 *
 * DECISION: a dedicated endpoint, not inlining `SpriteData` into every
 * `/api/creature` response. Reasoning, with the measured numbers behind it
 * in the T9 report:
 *
 * - The item sprite set is small and effectively static (10 sprites total,
 *   code-generated, changing only on a deploy). Inlining would repeat the
 *   exact same ~1-1.3KB of palette/frame JSON, per item, on EVERY single
 *   `/api/creature` response, for every repo row the extension renders,
 *   for every page view. That is the dominant cost on this endpoint: T6's
 *   own docs note it "will be hit by every extension user on every GitHub
 *   page view."
 * - A dedicated endpoint lets the extension fetch each item sprite exactly
 *   ONCE, ever (immutable long-lived cache below), then reuse it locally
 *   for every creature that references that item id afterward. That is a
 *   far better fit than paying the inline cost on every cached
 *   `/api/creature` hit.
 * - `item.def.sprite` (unchanged, frozen `ItemDef` shape) is already the
 *   exact id this route expects, so no change to `CreatureState`'s JSON
 *   shape was needed to wire this up: the extension (out of scope for this
 *   task) constructs `/api/creature/sprite/${item.def.sprite}` itself.
 *
 * Read `AGENTS.md` and Next 16's route handler docs (see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`)
 * before editing: dynamic segments resolve `params` as a Promise in this
 * version.
 */

import { getSprite } from '@/lib/game/sprites'

// A dynamic segment with no `generateStaticParams`: kept dynamic rather than
// `force-static` (which would try to prerender it at build time against an
// unbounded id space) and relies on the long-lived `Cache-Control` header
// below for actual caching, the same pattern `api/creature/route.ts` and
// `api/creature.svg/route.ts` use.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Sprite ids are lowercase-kebab, generated from ItemDef.id / StageId, e.g.
// 'spore-jar', 'ember-trail'. Reject anything else outright rather than
// passing an arbitrary string into the sprite registry lookup.
const SPRITE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params

  if (!SPRITE_ID_RE.test(id)) {
    return jsonResponse({ error: 'Invalid sprite id.' }, 400, noStoreHeaders())
  }

  const sprite = getSprite(id)
  if (!sprite) {
    return jsonResponse(
      { error: `No sprite registered for id '${id}'.` },
      404,
      noStoreHeaders()
    )
  }

  // Sprite pixel data is code-generated and only ever changes on a new
  // deploy, so this is safe to cache as long as browsers/CDNs allow.
  // `immutable` tells a caching client it never needs to revalidate this
  // exact URL for the lifetime of the max-age.
  return jsonResponse(sprite, 200, {
    ...corsHeaders(),
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function noStoreHeaders(): Record<string, string> {
  return { ...corsHeaders(), 'Cache-Control': 'no-store' }
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
