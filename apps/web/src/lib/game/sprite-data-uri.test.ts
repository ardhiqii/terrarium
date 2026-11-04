import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheClearAll } from './api-cache'
import { fetchSpriteDataUri, MAX_SPRITE_BYTES } from './sprite-data-uri'

/** Server-side sprite fetch for the dressed SVG badge. `fetch` is always mocked. */

const OK_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png'

function png(bytes: number, type = 'image/png'): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': type } })
}

beforeEach(() => cacheClearAll())
afterEach(() => {
  vi.unstubAllGlobals()
  cacheClearAll()
})

describe('fetchSpriteDataUri', () => {
  it('refuses any URL outside the PokeAPI sprites repo, without a request', async () => {
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    for (const url of [
      'https://example.com/a.png',
      'http://raw.githubusercontent.com/PokeAPI/sprites/a.png',
      'https://raw.githubusercontent.com/someone-else/sprites/a.png',
      'https://raw.githubusercontent.com/PokeAPI/sprites/master/a.gif',
    ]) {
      expect(await fetchSpriteDataUri(url)).toBeNull()
    }
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns a base64 PNG data URI and caches it', async () => {
    const fn = vi.fn(async () => png(10))
    vi.stubGlobal('fetch', fn)
    const first = await fetchSpriteDataUri(OK_URL)
    expect(first).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
    expect(await fetchSpriteDataUri(OK_URL)).toBe(first)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-PNG response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => png(10, 'text/html')))
    expect(await fetchSpriteDataUri(OK_URL)).toBeNull()
  })

  it('rejects an oversized body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => png(MAX_SPRITE_BYTES + 1)))
    expect(await fetchSpriteDataUri(OK_URL)).toBeNull()
  })

  it('caches a failure, so a broken upstream is not hit on every badge view', async () => {
    const fn = vi.fn(async () => new Response('x', { status: 503 }))
    vi.stubGlobal('fetch', fn)
    expect(await fetchSpriteDataUri(OK_URL)).toBeNull()
    expect(await fetchSpriteDataUri(OK_URL)).toBeNull()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('never throws on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await fetchSpriteDataUri(OK_URL)).toBeNull()
  })
})
