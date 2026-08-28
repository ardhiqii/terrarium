import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { Schema } from 'prosemirror-model'
import { MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown'
import {
  wikilinkMarkdownItRule,
  renderWikilinkToken,
  serializeWikilinkNode,
  WIKILINK_DATA_ATTR,
} from './wikilink-node'

/**
 * These tests exercise the two halves of the wikilink round trip with the
 * REAL markdown-it and prosemirror-markdown code, not stand-ins, which is
 * what actually proves lossless round-tripping. They deliberately avoid
 * touching the TipTap `Editor` class: constructing a live `Editor` requires
 * a browser DOM (`tiptap-markdown`'s parse path calls `window.DOMParser`),
 * which is unavailable in this project's Node-based vitest environment and
 * cannot be added without an extra dependency (jsdom/happy-dom) that was
 * not part of this change. The parse-to-HTML half (markdown-it, pure
 * string processing) and the serialize half (prosemirror-markdown's real
 * `MarkdownSerializer`, pure data-structure processing) are both DOM-free,
 * so both are tested against the real libraries here. A full live-browser
 * check is still owed and called out in the report.
 */

function markdownItWithWikilinks(): MarkdownIt {
  const md = new MarkdownIt()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.inline.ruler.before('text', 'wikilink', wikilinkMarkdownItRule as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  md.renderer.rules.wikilink = renderWikilinkToken as any
  return md
}

describe('wikilinkMarkdownItRule (markdown -> HTML, the parse half)', () => {
  const md = markdownItWithWikilinks()

  it('renders a plain wikilink as an unescaped data-wikilink span', () => {
    const html = md.renderInline('[[Tools for Thinking]]')
    expect(html).toBe(
      `<span ${WIKILINK_DATA_ATTR} data-target="Tools for Thinking">Tools for Thinking</span>`
    )
  })

  it('renders an aliased wikilink with the alias as the visible label', () => {
    const html = md.renderInline('[[Tools for Thinking|a better name]]')
    expect(html).toBe(
      `<span ${WIKILINK_DATA_ATTR} data-target="Tools for Thinking">a better name</span>`
    )
  })

  it('does not swallow a longer, unrelated bracket run past the first ]]', () => {
    const html = md.renderInline('[[Short]] then [[Also Short]]')
    expect(html).toBe(
      `<span ${WIKILINK_DATA_ATTR} data-target="Short">Short</span> then ` +
        `<span ${WIKILINK_DATA_ATTR} data-target="Also Short">Also Short</span>`
    )
  })

  it('leaves ordinary markdown links alone (only [[ triggers the rule)', () => {
    const html = md.renderInline('[a normal link](https://example.com)')
    expect(html).toContain('<a href="https://example.com">a normal link</a>')
  })
})

describe('serializeWikilinkNode (ProseMirror doc -> markdown, the serialize half)', () => {
  // A minimal schema mirroring what StarterKit + the Wikilink node produce:
  // just enough to build a real doc and run it through the real
  // prosemirror-markdown MarkdownSerializer.
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
      wikilink: {
        group: 'inline',
        inline: true,
        atom: true,
        attrs: { target: { default: '' }, label: { default: '' } },
      },
    },
  })

  const serializer = new MarkdownSerializer(
    {
      paragraph: defaultMarkdownSerializer.nodes.paragraph,
      text: defaultMarkdownSerializer.nodes.text,
      // `serializeWikilinkNode`'s parameter types are narrowed to exactly
      // the shape it reads (`state.write`, `node.attrs.{target,label}`),
      // which is stricter than prosemirror-markdown's generic
      // `(state, node, parent, index) => void` signature. Both are
      // satisfied at runtime; only the declared variance mismatches.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wikilink: serializeWikilinkNode as any,
    },
    {}
  )

  it('serializes a wikilink node back to the exact [[Target]] syntax, unescaped', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('See '),
        schema.node('wikilink', { target: 'Tools for Thinking', label: 'Tools for Thinking' }),
        schema.text(' for more.'),
      ]),
    ])

    expect(serializer.serialize(doc)).toBe('See [[Tools for Thinking]] for more.')
  })

  it('serializes an aliased wikilink back to [[Target|label]], preserving the alias', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('wikilink', { target: 'Tools for Thinking', label: 'a better name' }),
      ]),
    ])

    expect(serializer.serialize(doc)).toBe('[[Tools for Thinking|a better name]]')
  })

  it('round trips markdown -> HTML -> (simulated) doc -> markdown byte-identically', () => {
    const original = 'See [[Tools for Thinking]] and [[Old Title|a better name]] together.'

    // parse half: markdown -> the same target/label pairs a real DOMParser
    // would read off the rendered spans (attribute + text content).
    const md = markdownItWithWikilinks()
    const tokens: { type: string; meta?: { target: string; label: string } }[] = []
    const parsed = md.parseInline(original, {})[0]
    for (const t of parsed.children ?? []) {
      if (t.type === 'wikilink') tokens.push(t)
    }
    expect(tokens.map((t) => t.meta)).toEqual([
      { target: 'Tools for Thinking', label: 'Tools for Thinking' },
      { target: 'Old Title', label: 'a better name' },
    ])

    // serialize half: rebuild a doc from those same target/label pairs and
    // confirm the original text (including the surrounding plain words)
    // comes back exactly.
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('See '),
        schema.node('wikilink', tokens[0].meta),
        schema.text(' and '),
        schema.node('wikilink', tokens[1].meta),
        schema.text(' together.'),
      ]),
    ])
    expect(serializer.serialize(doc)).toBe(original)
  })

  it('demonstrates the bug this node exists to prevent: plain text brackets DO get escaped', () => {
    // Without the atomic wikilink node, [[Title]] typed or loaded as plain
    // text is exactly what MarkdownSerializerState.esc() mangles. This
    // test documents the failure mode the rest of this file exists to
    // avoid, using the same real serializer with no wikilink node involved.
    const plainTextSerializer = new MarkdownSerializer(
      {
        paragraph: defaultMarkdownSerializer.nodes.paragraph,
        text: defaultMarkdownSerializer.nodes.text,
      },
      {}
    )
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('[[Tools for Thinking]]')]),
    ])

    expect(plainTextSerializer.serialize(doc)).toBe('\\[\\[Tools for Thinking\\]\\]')
  })
})
