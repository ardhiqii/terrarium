/**
 * Fetch a companion's still sprite and return it as a `data:` URI for the SVG badge.
 *
 * WHY: GitHub shows a README badge through an <img>, and an SVG loaded as an image
 * may not fetch anything external. The dressed-repo badge therefore has to carry
 * its sprite inline. See `renderDressedBadgeSvg`.
 *
 * GUARDS, because this is a server-side fetch driven by data that came from a
 * user's snapshot (via the catalog):
 *   - only `https://raw.githubusercontent.com/PokeAPI/sprites/` is ever fetched;
 *   - only `image/png` is accepted, and at most `MAX_SPRITE_BYTES`;
 *   - a short timeout, no redirects followed;
 *   - success is cached for a day, failure for ten minutes, so a broken upstream
 *     cannot turn every badge view into an outbound request.
 *
 * Never throws: null means "draw the empty mount".
 */

import { cacheGetFresh, cacheSet } from './api-cache'

export const SPRITE_URL_PREFIX = 'https://raw.githubusercontent.com/PokeAPI/sprites/'
export const MAX_SPRITE_BYTES = 64 * 1024
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000
const FAILURE_TTL_MS = 10 * 60 * 1000
const TIMEOUT_MS = 5000

export async function fetchSpriteDataUri(url: string): Promise<string | null> {
  if (!url.startsWith(SPRITE_URL_PREFIX) || !url.endsWith('.png')) return null

  const cacheKey = `spriteuri:${url}`
  const cached = cacheGetFresh<string>(cacheKey)
  if (cached !== undefined) return cached || null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok || !type.toLowerCase().startsWith('image/png')) {
      cacheSet(cacheKey, '', FAILURE_TTL_MS)
      return null
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_SPRITE_BYTES) {
      cacheSet(cacheKey, '', FAILURE_TTL_MS)
      return null
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_SPRITE_BYTES) {
      cacheSet(cacheKey, '', FAILURE_TTL_MS)
      return null
    }
    const uri = `data:image/png;base64,${bytes.toString('base64')}`
    cacheSet(cacheKey, uri, SUCCESS_TTL_MS)
    return uri
  } catch {
    cacheSet(cacheKey, '', FAILURE_TTL_MS)
    return null
  } finally {
    clearTimeout(timeout)
  }
}
