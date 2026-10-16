import { NextRequest } from 'next/server'
import { PROTOTYPE_COMPANION_CATALOG } from '@/lib/game/companion-catalog'
import { getProductStore } from '@/lib/sync/product-store'
import { getSessionProvider } from '@/lib/sync/session'
import { requestAccountMatchesSession } from '@/lib/sync/request-account-guard'
import { trustStoredProductSnapshot } from '@/lib/sync/trusted-product-snapshot'
import { validateProductSnapshot, type ProductSnapshot } from '@/lib/sync/product-snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
    },
  })
}

export async function POST(request: NextRequest): Promise<Response> {
  const session = await getSessionProvider().current()
  if (!session) return json(401, { error: 'Sign in required.' })
  if (!requestAccountMatchesSession(request, session.githubId)) {
    return json(409, { error: 'account_changed' })
  }

  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > 16 * 1024) {
    return json(413, { error: 'Activation request is too large.' })
  }
  let body: unknown
  try {
    const raw = await request.text()
    if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) {
      return json(413, { error: 'Activation request is too large.' })
    }
    body = JSON.parse(raw)
  } catch {
    return json(400, { error: 'Invalid activation request.' })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as { companionId?: unknown }).companionId !== 'string') {
    return json(400, { error: 'companionId is required.' })
  }
  const companionId = (body as { companionId: string }).companionId.trim()
  const definition = PROTOTYPE_COMPANION_CATALOG.get(companionId)
  if (!definition) return json(400, { error: 'Unknown companion.' })

  try {
    const store = getProductStore()
    const record = await store.getRecord(session.githubId, session.handle)
    if (!record) return json(404, { error: 'No synced companion state exists yet.' })

    const trusted = trustStoredProductSnapshot(record.snapshot, session.githubId)
    if (!trusted.collection.some((reference) => reference.companionId === companionId)) {
      return json(400, { error: 'Companion is not owned by this account.' })
    }

    const selectedAt = new Date().toISOString()
    const next: ProductSnapshot = {
      ...trusted,
      activeCompanionId: companionId,
      activeSelection: {
        companionId,
        provenance: 'user',
        selectedAt,
      },
      updatedAt: selectedAt,
      generatedAt: selectedAt,
    }
    validateProductSnapshot(next)
    const saved = await store.put(
      session.githubId,
      session.handle,
      next,
      selectedAt,
      record.updatedAt,
    )
    if (!saved) return json(409, { error: 'The account changed while activation was saving.' })
    return json(200, { ok: true, activeCompanionId: companionId })
  } catch {
    return json(503, { error: 'storage_unavailable' })
  }
}
