/**
 * Contract tests for `GET /api/creature.svg`. The one promise this route
 * makes that `api/creature/route.ts` does not: it must NEVER return JSON and
 * NEVER return a 500. A broken image in someone's README is worse than a
 * degraded one, so every failure case below is asserted to still be a 200
 * `image/svg+xml` response containing well-formed XML.
 *
 * `fetch` is mocked throughout, same pattern as `api/creature/route.test.ts`.
 * The XML well-formedness parser lives in `svg-render.test.ts` and is
 * reused here via the `@/` alias rather than duplicated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Minimal XML well-formedness parser, deliberately duplicated (not imported)
// from `apps/web/src/lib/game/svg-render.test.ts`. Importing a sibling `.test.ts`
// module re-executes its top-level `describe`/`it` calls too, which would
// silently register that whole file's suite a second time here. See
// `svg-render.test.ts` for the full rationale (no XML parser package is
// available without `npm install`) and the complete, exercised version of
// this parser; this copy only needs `parseXml` and `findAll`.
// ---------------------------------------------------------------------------

interface XmlElement {
  tag: string
  attrs: Record<string, string>
  children: XmlElement[]
  text: string
}

class XmlParseError extends Error {}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(raw: string, context: string): string {
  let result = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '<') throw new XmlParseError(`unescaped '<' in ${context}`)
    if (ch === '&') {
      const m = /^&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/.exec(raw.slice(i))
      if (!m) throw new XmlParseError(`unescaped '&' in ${context}`)
      const ent = m[1]
      if (ent[0] === '#') {
        const isHex = ent[1] === 'x' || ent[1] === 'X'
        const codePoint = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10)
        if (!Number.isFinite(codePoint)) {
          throw new XmlParseError(`invalid numeric character reference in ${context}: ${m[0]}`)
        }
        result += String.fromCodePoint(codePoint)
      } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent)) {
        result += NAMED_ENTITIES[ent]
      } else {
        throw new XmlParseError(`unknown entity reference in ${context}: ${m[0]}`)
      }
      i += m[0].length
      continue
    }
    result += ch
    i += 1
  }
  return result
}

function parseXml(source: string): XmlElement {
  let i = 0
  const n = source.length
  const skipWhitespace = () => {
    while (i < n && /\s/.test(source[i])) i++
  }
  const peekIs = (str: string) => source.startsWith(str, i)
  const skipMisc = () => {
    while (true) {
      skipWhitespace()
      if (peekIs('<!--')) {
        const end = source.indexOf('-->', i)
        if (end === -1) throw new XmlParseError('unterminated comment')
        i = end + 3
        continue
      }
      break
    }
  }

  skipWhitespace()
  if (peekIs('<?xml')) {
    const end = source.indexOf('?>', i)
    if (end === -1) throw new XmlParseError('unterminated XML declaration')
    i = end + 2
  } else {
    throw new XmlParseError('document does not start with an XML declaration')
  }

  skipMisc()
  if (i >= n || source[i] !== '<') throw new XmlParseError('expected root element')
  const root = parseElement()
  skipMisc()
  if (i < n) throw new XmlParseError(`unexpected content after root element at index ${i}`)
  return root

  function parseElement(): XmlElement {
    if (source[i] !== '<') throw new XmlParseError(`expected '<' at index ${i}`)
    i++
    const tagMatch = /^[a-zA-Z_][\w:.-]*/.exec(source.slice(i))
    if (!tagMatch) throw new XmlParseError(`expected tag name at index ${i}`)
    const tag = tagMatch[0]
    i += tag.length

    const attrs: Record<string, string> = {}
    while (true) {
      skipWhitespace()
      if (peekIs('/>')) {
        i += 2
        return { tag, attrs, children: [], text: '' }
      }
      if (peekIs('>')) {
        i += 1
        break
      }
      const attrMatch = /^[a-zA-Z_][\w:.-]*/.exec(source.slice(i))
      if (!attrMatch) throw new XmlParseError(`expected attribute or '>' in <${tag}> at index ${i}`)
      const attrName = attrMatch[0]
      i += attrName.length
      skipWhitespace()
      if (source[i] !== '=') {
        throw new XmlParseError(`expected '=' after attribute '${attrName}' in <${tag}>`)
      }
      i++
      skipWhitespace()
      const quote = source[i]
      if (quote !== '"' && quote !== "'") {
        throw new XmlParseError(`attribute '${attrName}' value must be quoted in <${tag}>`)
      }
      i++
      const valueStart = i
      while (i < n && source[i] !== quote) {
        if (source[i] === '<') {
          throw new XmlParseError(`unescaped '<' inside attribute '${attrName}' of <${tag}>`)
        }
        i++
      }
      if (i >= n) throw new XmlParseError(`unterminated attribute value in <${tag}>`)
      const rawValue = source.slice(valueStart, i)
      i++
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) {
        throw new XmlParseError(`duplicate attribute '${attrName}' in <${tag}>`)
      }
      attrs[attrName] = decodeEntities(rawValue, `attribute '${attrName}' of <${tag}>`)
    }

    const children: XmlElement[] = []
    let text = ''
    while (true) {
      if (i >= n) throw new XmlParseError(`unterminated element <${tag}>: missing closing tag`)
      if (peekIs('</')) {
        const closeMatch = /^<\/([a-zA-Z_][\w:.-]*)\s*>/.exec(source.slice(i))
        if (!closeMatch) throw new XmlParseError(`malformed closing tag near index ${i}`)
        if (closeMatch[1] !== tag) {
          throw new XmlParseError(
            `mismatched closing tag: expected </${tag}>, got </${closeMatch[1]}>`
          )
        }
        i += closeMatch[0].length
        return { tag, attrs, children, text }
      }
      if (peekIs('<!--')) {
        const end = source.indexOf('-->', i)
        if (end === -1) throw new XmlParseError('unterminated comment')
        i = end + 3
        continue
      }
      if (peekIs('<![CDATA[')) {
        const end = source.indexOf(']]>', i)
        if (end === -1) throw new XmlParseError('unterminated CDATA section')
        text += source.slice(i + 9, end)
        i = end + 3
        continue
      }
      if (source[i] === '<') {
        children.push(parseElement())
        continue
      }
      const textStart = i
      while (i < n && source[i] !== '<') i++
      text += decodeEntities(source.slice(textStart, i), `text content of <${tag}>`)
    }
  }
}

function allElements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const walk = (node: XmlElement) => {
    out.push(node)
    for (const c of node.children) walk(c)
  }
  walk(el)
  return out
}

function findAll(el: XmlElement, tag: string): XmlElement[] {
  return allElements(el).filter((e) => e.tag === tag)
}

function freshHandle(): string {
  return `svgu${Math.random().toString(36).slice(2, 10)}`
}

type FetchRoute = { match: RegExp; handle: (url: string) => Response | Promise<Response> }

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(routes: FetchRoute[]) {
  const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    for (const route of routes) {
      if (route.match.test(url)) return route.handle(url)
    }
    throw new Error(`unmocked fetch call in test: ${url}`)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function userExistsRoute(): FetchRoute {
  return { match: /\/users\/[^/]+$/, handle: () => jsonRes(200, { login: 'x' }) }
}
function userNotFoundRoute(): FetchRoute {
  return { match: /\/users\/[^/]+$/, handle: () => jsonRes(404, { message: 'Not Found' }) }
}
function repoExistsRoute(): FetchRoute {
  return { match: /\/repos\/[^/]+\/[^/]+$/, handle: () => jsonRes(200, { name: 'x' }) }
}
function repoNotFoundRoute(): FetchRoute {
  return { match: /\/repos\/[^/]+\/[^/]+$/, handle: () => jsonRes(404, { message: 'Not Found' }) }
}
function emptyEventsRoute(): FetchRoute {
  return { match: /\/events\/public/, handle: () => jsonRes(200, []) }
}
function rateLimitedEventsRoute(): FetchRoute {
  return {
    match: /\/events\/public/,
    handle: () =>
      new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
  }
}

async function importRoute() {
  vi.resetModules()
  return import('./route')
}

async function assertAlwaysSvg200(res: Response) {
  expect(res.status).toBe(200)
  expect(res.headers.get('Content-Type')).toContain('image/svg+xml')
  const text = await res.text()
  expect(() => parseXml(text)).not.toThrow()
  return text
}

beforeEach(() => {
  process.env.GITHUB_LOGIN = 'definitely-not-a-test-handle-owner'
  delete process.env.GITHUB_TOKEN
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/creature.svg: every failure case is a renderable SVG, never JSON, never 500', () => {
  it('missing user', async () => {
    mockFetch([])
    const { GET } = await importRoute()
    const res = await GET(new NextRequest('http://localhost/api/creature.svg'))
    await assertAlwaysSvg200(res)
  })

  it('invalid handle shape', async () => {
    const fetchMock = mockFetch([])
    const { GET } = await importRoute()
    const res = await GET(
      new NextRequest('http://localhost/api/creature.svg?user=-bad-handle')
    )
    await assertAlwaysSvg200(res)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('invalid repo name shape', async () => {
    mockFetch([])
    const { GET } = await importRoute()
    const res = await GET(
      new NextRequest(
        `http://localhost/api/creature.svg?user=octocat&repo=${encodeURIComponent('..')}`
      )
    )
    await assertAlwaysSvg200(res)
  })

  it('nonexistent user', async () => {
    mockFetch([userNotFoundRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(new NextRequest(`http://localhost/api/creature.svg?user=${user}`))
    const text = await assertAlwaysSvg200(res)
    expect(text).toMatch(/not found/i)
  })

  it('nonexistent repo', async () => {
    mockFetch([userExistsRoute(), repoNotFoundRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(
      new NextRequest(`http://localhost/api/creature.svg?user=${user}&repo=nope`)
    )
    const text = await assertAlwaysSvg200(res)
    expect(text).toMatch(/not found/i)
  })

  it('upstream GitHub rate limit degrades to a 200 SVG', async () => {
    mockFetch([userExistsRoute(), rateLimitedEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(new NextRequest(`http://localhost/api/creature.svg?user=${user}`))
    const text = await assertAlwaysSvg200(res)
    // renderCreatureBadgeSvg's degraded note.
    expect(text).toMatch(/degraded/i)
  })

  it('a network failure on the events fetch still returns a 200 SVG, not a 500', async () => {
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (/\/users\/[^/]+$/.test(url)) return jsonRes(200, { login: 'x' })
      if (/\/events\/public/.test(url)) throw new TypeError('fetch failed')
      throw new Error(`unmocked fetch call in test: ${url}`)
    })
    vi.stubGlobal('fetch', fn)
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(new NextRequest(`http://localhost/api/creature.svg?user=${user}`))
    await assertAlwaysSvg200(res)
  })

  it("this endpoint's own rate limiter degrades to a 200 SVG rather than a 429", async () => {
    mockFetch([userExistsRoute(), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    // Exhaust the per-IP limiter (default RATE_LIMIT_MAX=30/min, no
    // x-forwarded-for header means every call in this test shares the
    // 'unknown' IP bucket).
    let last: Response | null = null
    for (let i = 0; i < 31; i++) {
      last = await GET(new NextRequest(`http://localhost/api/creature.svg?user=${user}${i}`))
    }
    expect(last).not.toBeNull()
    await assertAlwaysSvg200(last!)
  })
})

describe('GET /api/creature.svg: happy path', () => {
  it('renders a well-formed badge for a valid handle, with the handle escaped/embedded', async () => {
    mockFetch([userExistsRoute(), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(new NextRequest(`http://localhost/api/creature.svg?user=${user}`))
    const text = await assertAlwaysSvg200(res)
    const root = parseXml(text)
    const identityText = findAll(root, 'text')
      .map((t) => t.text)
      .find((t) => t.startsWith('@'))
    expect(identityText).toBe(`@${user}`)
  })

  it('respects theme=dark and produces a different (still well-formed) document', async () => {
    mockFetch([userExistsRoute(), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const lightRes = await GET(
      new NextRequest(`http://localhost/api/creature.svg?user=${user}&theme=light`)
    )
    const darkRes = await GET(
      new NextRequest(`http://localhost/api/creature.svg?user=${user}&theme=dark`)
    )
    const lightText = await assertAlwaysSvg200(lightRes)
    const darkText = await assertAlwaysSvg200(darkRes)
    expect(lightText).not.toBe(darkText)
  })

  it('renders a repo badge distinctly from the user badge', async () => {
    mockFetch([userExistsRoute(), repoExistsRoute(), emptyEventsRoute()])
    const { GET } = await importRoute()
    const user = freshHandle()
    const res = await GET(
      new NextRequest(`http://localhost/api/creature.svg?user=${user}&repo=my-repo`)
    )
    const text = await assertAlwaysSvg200(res)
    const root = parseXml(text)
    const identityText = findAll(root, 'text')
      .map((t) => t.text)
      .find((t) => t.startsWith('@'))
    expect(identityText).toBe(`@${user}/my-repo`)
  })
})

describe('GET /api/creature.svg: CORS', () => {
  it('OPTIONS returns 204 with CORS headers', async () => {
    mockFetch([])
    const { OPTIONS } = await importRoute()
    const res = await OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  it('the SVG response carries CORS headers too', async () => {
    mockFetch([])
    const { GET } = await importRoute()
    const res = await GET(new NextRequest('http://localhost/api/creature.svg'))
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
