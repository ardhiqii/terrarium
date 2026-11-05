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

/**
 * Only a canonical PokeAPI sprites URL. A prefix test alone passes
 * `.../PokeAPI/sprites/../../other/x.png`, which `fetch` resolves to another
 * repository; requiring the parsed `href` to equal the input rules out `..`,
 * `%2e%2e`, backslashes, credentials and ports.
 */
export function isPokeApiSpriteUrl(url: string): boolean {
  if (typeof url !== 'string' || !url.startsWith(SPRITE_URL_PREFIX) || !url.endsWith('.png')) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.href === url &&
    parsed.protocol === 'https:' &&
    parsed.host === 'raw.githubusercontent.com' &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname.startsWith('/PokeAPI/sprites/') &&
    !/%2e/i.test(parsed.pathname)
  )
}

export async function fetchSpriteDataUri(url: string): Promise<string | null> {
  if (!isPokeApiSpriteUrl(url)) return null

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
    const bytes = await readCapped(response, MAX_SPRITE_BYTES)
    if (!bytes || bytes.length === 0) {
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

/**
 * Read at most `limit` bytes, stopping the download the moment it grows past it.
 *
 * `arrayBuffer()` allocates the whole response before the size check can run, so
 * a hostile or broken upstream could make the badge server hold megabytes it will
 * only throw away. Reading the stream lets us hang up mid-download instead.
 * Returns null when the body is too large or cannot be read.
 */
async function readCapped(response: Response, limit: number): Promise<Buffer | null> {
  if (!response.body) {
    const fallback = Buffer.from(await response.arrayBuffer())
    return fallback.length > limit ? null : fallback
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}
