/**
 * `svg-render.ts` ships into other people's READMEs, where a malformed SVG
 * renders as a broken image. This file asserts well-formedness, XML
 * escaping, "no animation" (camo strips it, so its presence is a lie about
 * the badge being static), "no external references" (camo would never
 * proxy them), that `var(--sprite-outline)` is resolved to a concrete
 * colour, and that both themes are readable.
 *
 * NO XML PARSER PACKAGE IS AVAILABLE. Checked `node_modules` for jsdom,
 * xmldom, linkedom, happy-dom, fast-xml-parser, sax, txml: none present, and
 * none are reachable without `npm install`, which this task is not allowed
 * to run. `parse5` is present transitively but implements the lenient HTML5
 * parsing algorithm (it silently repairs broken markup rather than
 * rejecting it), which is the opposite of what "assert well-formed XML"
 * needs. Node has no built-in DOMParser either. So this file carries a
 * small hand-rolled XML well-formedness parser below (`parseXml`) instead
 * of a regex check on the raw string. It is intentionally minimal: no DTD
 * support, no full namespace resolution, no processing instructions besides
 * the leading `<?xml ... ?>` -- just enough to prove tag balance, attribute
 * quoting, and entity correctness, which is what "well-formed XML" means
 * for this badge's purposes. Exported so `creature.svg/route.test.ts` can
 * reuse it instead of carrying a second copy.
 */
import { describe, it, expect } from 'vitest'
import {
  renderCreatureBadgeSvg,
  renderMessageSvg,
  escapeXml,
  resolveTheme,
  BADGE_WIDTH,
  BADGE_HEIGHT,
  type CreatureBadgeParams,
} from './svg-render'
import { STAGES } from './types'
import type { SpriteData, Stage } from './types'

// ---------------------------------------------------------------------------
// Minimal hand-rolled XML well-formedness parser. See file header for why.
// ---------------------------------------------------------------------------

export interface XmlElement {
  tag: string
  attrs: Record<string, string>
  children: XmlElement[]
  /** Concatenated, entity-decoded direct text content (not descendants'). */
  text: string
}

export class XmlParseError extends Error {}

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
    if (ch === '<') {
      throw new XmlParseError(`unescaped '<' in ${context}`)
    }
    if (ch === '&') {
      const m = /^&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/.exec(raw.slice(i))
      if (!m) {
        throw new XmlParseError(`unescaped '&' (invalid or missing entity) in ${context}`)
      }
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

/** Parses a single well-formed XML document and returns its root element. */
export function parseXml(source: string): XmlElement {
  let i = 0
  const n = source.length

  function skipWhitespace() {
    while (i < n && /\s/.test(source[i])) i++
  }

  function peekIs(str: string): boolean {
    return source.startsWith(str, i)
  }

  function skipMisc() {
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
  if (i >= n || source[i] !== '<') {
    throw new XmlParseError('expected root element')
  }

  const root = parseElement()
  skipMisc()
  if (i < n) {
    throw new XmlParseError(`unexpected content after root element at index ${i}`)
  }
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
      if (!attrMatch) {
        throw new XmlParseError(`expected attribute or '>' in <${tag}> at index ${i}`)
      }
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
      i++ // closing quote
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

export function allElements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const walk = (node: XmlElement) => {
    out.push(node)
    for (const c of node.children) walk(c)
  }
  walk(el)
  return out
}

export function findAll(el: XmlElement, tag: string): XmlElement[] {
  return allElements(el).filter((e) => e.tag === tag)
}

// ---------------------------------------------------------------------------
// Contrast helper (WCAG relative luminance), for the "readable colour pairs"
// assertion.
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  const cs = c / 255
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex)
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`)
  const r = parseInt(m[1].slice(0, 2), 16)
  const g = parseInt(m[1].slice(2, 4), 16)
  const b = parseInt(m[1].slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STAGE: Stage = STAGES[1] // Mossling, has both a previous and a next stage

const SPRITE: SpriteData = {
  id: 'fixture-sprite',
  width: 2,
  height: 2,
  palette: ['transparent', '#3a2f1a', 'var(--sprite-outline)'],
  frames: [['12', '21']],
}

function baseParams(overrides: Partial<CreatureBadgeParams> = {}): CreatureBadgeParams {
  return {
    sprite: SPRITE,
    stage: STAGE,
    stageCount: STAGES.length,
    totalXp: 1800,
    xpIntoStage: 300,
    xpForNextStage: 3500,
    progress: 300 / 3500,
    handle: 'octocat',
    repo: null,
    degraded: false,
    theme: 'light',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

describe('renderCreatureBadgeSvg: well-formed XML', () => {
  it('parses without throwing and has a single <svg> root', () => {
    const svg = renderCreatureBadgeSvg(baseParams())
    const root = parseXml(svg)
    expect(root.tag).toBe('svg')
  })

  it('starts with exactly one XML declaration', () => {
    const svg = renderCreatureBadgeSvg(baseParams())
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(svg.match(/<\?xml/g)?.length).toBe(1)
  })

  it('declares the SVG namespace and matches BADGE_WIDTH/BADGE_HEIGHT', () => {
    const svg = renderCreatureBadgeSvg(baseParams())
    const root = parseXml(svg)
    expect(root.attrs.xmlns).toBe('http://www.w3.org/2000/svg')
    expect(root.attrs.width).toBe(String(BADGE_WIDTH))
    expect(root.attrs.height).toBe(String(BADGE_HEIGHT))
  })

  it('stays well-formed for a repo badge, a degraded badge, and a very long handle', () => {
    expect(() => parseXml(renderCreatureBadgeSvg(baseParams({ repo: 'my-repo' })))).not.toThrow()
    expect(() => parseXml(renderCreatureBadgeSvg(baseParams({ degraded: true })))).not.toThrow()
    expect(() =>
      parseXml(renderCreatureBadgeSvg(baseParams({ handle: 'x'.repeat(200) })))
    ).not.toThrow()
  })

  it('stays well-formed at every stage and both themes', () => {
    for (const stage of STAGES) {
      for (const theme of ['light', 'dark'] as const) {
        const svg = renderCreatureBadgeSvg(baseParams({ stage, theme }))
        expect(() => parseXml(svg)).not.toThrow()
      }
    }
  })
})

describe('renderMessageSvg: well-formed XML', () => {
  it('parses without throwing and has a single <svg> root', () => {
    const svg = renderMessageSvg('user is not a valid GitHub handle')
    const root = parseXml(svg)
    expect(root.tag).toBe('svg')
  })

  it('stays well-formed for both themes', () => {
    expect(() => parseXml(renderMessageSvg('rate limited', 'light'))).not.toThrow()
    expect(() => parseXml(renderMessageSvg('rate limited', 'dark'))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// XML escaping: the assertion that protects other people's READMEs.
// ---------------------------------------------------------------------------

describe('XML escaping', () => {
  const DANGEROUS = `a&b<c>d"e'f`

  it('escapeXml round-trips through the hand-rolled decoder for every special character', () => {
    const escaped = escapeXml(DANGEROUS)
    // The escaped form must not contain a bare instance of any special char.
    expect(escaped).not.toMatch(/[<>]/)
    // decodeEntities is exercised indirectly via parseXml below; also spot
    // check the escaped string itself is the expected entity form.
    expect(escaped).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
  })

  it('a handle containing & < > " \' produces valid, well-formed SVG with the identity intact', () => {
    const svg = renderCreatureBadgeSvg(baseParams({ handle: DANGEROUS, repo: null }))
    const root = parseXml(svg)
    const identityText = findAll(root, 'text')
      .map((t) => t.text)
      .find((t) => t.startsWith('@'))
    expect(identityText).toBe(`@${DANGEROUS}`)
  })

  it('a repo name containing & < > " \' produces valid, well-formed SVG with the identity intact', () => {
    const svg = renderCreatureBadgeSvg(
      baseParams({ handle: 'octocat', repo: DANGEROUS })
    )
    const root = parseXml(svg)
    const identityText = findAll(root, 'text')
      .map((t) => t.text)
      .find((t) => t.startsWith('@'))
    expect(identityText).toBe(`@octocat/${DANGEROUS}`)
  })

  it('a degraded/failure message containing & < > " \' renders as valid, well-formed SVG', () => {
    const svg = renderMessageSvg(`GitHub user '${DANGEROUS}' was not found`)
    const root = parseXml(svg)
    expect(() => parseXml(svg)).not.toThrow()
    const messageText = findAll(root, 'text')[0]?.text ?? ''
    expect(messageText).toContain(DANGEROUS)
  })

  it('handles a lone ampersand and unmatched angle brackets without becoming malformed', () => {
    const nasty = `<<<&&&>>>`
    const svg = renderMessageSvg(nasty)
    expect(() => parseXml(svg)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// No animation
// ---------------------------------------------------------------------------

describe('no animation', () => {
  const FORBIDDEN_TAGS = ['style', 'animate', 'animateTransform', 'animateMotion', 'set', 'script']

  it('the creature badge never emits a <style>, <animate*>, <set>, or <script> element', () => {
    const svg = renderCreatureBadgeSvg(baseParams({ degraded: true }))
    const root = parseXml(svg)
    const tags = new Set(allElements(root).map((e) => e.tag))
    for (const forbidden of FORBIDDEN_TAGS) {
      expect(tags.has(forbidden)).toBe(false)
    }
  })

  it('the message badge never emits a <style>, <animate*>, <set>, or <script> element', () => {
    const svg = renderMessageSvg('rate limit exceeded')
    const root = parseXml(svg)
    const tags = new Set(allElements(root).map((e) => e.tag))
    for (const forbidden of FORBIDDEN_TAGS) {
      expect(tags.has(forbidden)).toBe(false)
    }
  })

  it('renders only frame 0: only one sprite <g> group is present', () => {
    const svg = renderCreatureBadgeSvg(baseParams())
    const root = parseXml(svg)
    const groups = findAll(root, 'g')
    expect(groups.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// No external references
// ---------------------------------------------------------------------------

describe('no external references', () => {
  it('the only URL in the document is the SVG namespace declaration', () => {
    const svg = renderCreatureBadgeSvg(baseParams({ repo: 'my-repo', degraded: true }))
    const root = parseXml(svg)
    for (const el of allElements(root)) {
      for (const [name, value] of Object.entries(el.attrs)) {
        if (name === 'xmlns') {
          expect(value).toBe('http://www.w3.org/2000/svg')
          continue
        }
        expect(value).not.toMatch(/^https?:\/\//)
      }
    }
  })

  it('never emits an href or xlink:href attribute (no <image> references)', () => {
    const svg = renderCreatureBadgeSvg(baseParams())
    const root = parseXml(svg)
    for (const el of allElements(root)) {
      expect(el.attrs.href).toBeUndefined()
      expect(el.attrs['xlink:href']).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// var(--sprite-outline) resolution
// ---------------------------------------------------------------------------

describe('sprite outline colour resolution', () => {
  it('resolves var(--sprite-outline) to a concrete colour, for both themes', () => {
    const lightSvg = renderCreatureBadgeSvg(baseParams({ theme: 'light' }))
    const darkSvg = renderCreatureBadgeSvg(baseParams({ theme: 'dark' }))
    expect(lightSvg).not.toContain('var(')
    expect(darkSvg).not.toContain('var(')

    const lightRoot = parseXml(lightSvg)
    const darkRoot = parseXml(darkSvg)
    const lightFills = findAll(lightRoot, 'rect').map((r) => r.attrs.fill)
    const darkFills = findAll(darkRoot, 'rect').map((r) => r.attrs.fill)
    // The resolved outline colour must be a real hex colour, not left over
    // as the literal CSS var() reference or dropped entirely.
    expect(lightFills.some((f) => /^#[0-9a-fA-F]{6}$/.test(f ?? ''))).toBe(true)
    expect(darkFills.some((f) => /^#[0-9a-fA-F]{6}$/.test(f ?? ''))).toBe(true)
    // Light and dark resolve the same CSS variable to different concrete
    // colours (see THEME_COLORS in svg-render.ts).
    expect(lightSvg).not.toBe(darkSvg)
  })
})

// ---------------------------------------------------------------------------
// Theme readability
// ---------------------------------------------------------------------------

describe('theme readability', () => {
  function panelAndInkColors(svg: string): { panel: string; ink: string } {
    const root = parseXml(svg)
    const panel = findAll(root, 'rect').find((r) => r.attrs.rx === '10')?.attrs.fill
    const ink = findAll(root, 'text').find((t) => t.attrs['font-weight'] === '600')?.attrs.fill
    if (!panel || !ink) {
      throw new Error('could not locate panel background or ink text colour in rendered SVG')
    }
    return { panel, ink }
  }

  it('light theme: stage name text is readable against the panel background', () => {
    const svg = renderCreatureBadgeSvg(baseParams({ theme: 'light' }))
    const { panel, ink } = panelAndInkColors(svg)
    expect(contrastRatio(panel, ink)).toBeGreaterThanOrEqual(4.5)
  })

  it('dark theme: stage name text is readable against the panel background', () => {
    const svg = renderCreatureBadgeSvg(baseParams({ theme: 'dark' }))
    const { panel, ink } = panelAndInkColors(svg)
    expect(contrastRatio(panel, ink)).toBeGreaterThanOrEqual(4.5)
  })
})

// ---------------------------------------------------------------------------
// resolveTheme
// ---------------------------------------------------------------------------

describe('resolveTheme', () => {
  it("returns 'dark' only for the literal string 'dark'", () => {
    expect(resolveTheme('dark')).toBe('dark')
  })

  it('defaults to light for null, empty, and anything else', () => {
    expect(resolveTheme(null)).toBe('light')
    expect(resolveTheme('')).toBe('light')
    expect(resolveTheme('Dark')).toBe('light')
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('anything-else')).toBe('light')
  })
})

// ---------------------------------------------------------------------------
// The hand-rolled parser's own correctness (a false-negative here would
// silently defeat every assertion above).
// ---------------------------------------------------------------------------

describe('parseXml (self-test)', () => {
  it('throws on mismatched tags', () => {
    expect(() => parseXml('<?xml version="1.0"?><a><b></a></b>')).toThrow(XmlParseError)
  })

  it('throws on an unquoted attribute', () => {
    expect(() => parseXml('<?xml version="1.0"?><a b=c></a>')).toThrow(XmlParseError)
  })

  it('throws on a bare ampersand', () => {
    expect(() => parseXml('<?xml version="1.0"?><a>1 & 2</a>')).toThrow(XmlParseError)
  })

  it('throws on a bare unescaped <', () => {
    expect(() => parseXml('<?xml version="1.0"?><a>1 < 2</a>')).toThrow(XmlParseError)
  })

  it('throws on multiple root elements', () => {
    expect(() => parseXml('<?xml version="1.0"?><a/><b/>')).toThrow(XmlParseError)
  })

  it('accepts a well-formed document with escaped entities and a self-closing child', () => {
    const root = parseXml('<?xml version="1.0"?><a x="1 &amp; 2"><b/>hi &lt;there&gt;</a>')
    expect(root.tag).toBe('a')
    expect(root.attrs.x).toBe('1 & 2')
    expect(root.children[0].tag).toBe('b')
    expect(root.text).toBe('hi <there>')
  })
})
