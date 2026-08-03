/**
 * A TipTap node that renders `[[Target]]` / `[[Target|alias]]` as a single
 * atomic inline chip in the WYSIWYG surface, and serializes back to the
 * exact same markdown syntax.
 *
 * This exists because of a real defect in the naive approach: plain text
 * containing `[[Wikilink]]`, run through `tiptap-markdown` (which delegates
 * to `prosemirror-markdown`'s `MarkdownSerializerState.esc()`), comes back
 * backslash-escaped as `\[\[Wikilink\]\]`. `esc()` escapes `[` and `]`
 * unconditionally because those characters are meaningful for ordinary
 * markdown links `[text](url)`; it has no idea a wikilink is special. Left
 * alone this silently corrupts every wikilink saved through this editor,
 * which is exactly the class of bug T24 exists to prevent. Routing
 * wikilinks through their own atomic node, whose `markdown.serialize`
 * bypasses `esc()` entirely via `state.write()`, avoids it.
 *
 * Reuses `parseWikilink` from `src/lib/utils.ts` for the target/alias
 * split, both when typed markdown is parsed on load and when the user
 * finishes typing `]]` live in the editor, per T24's instruction not to
 * write a second wikilink parser.
 */

import { Node, mergeAttributes, nodeInputRule } from '@tiptap/core'
import { parseWikilink } from '@/lib/utils'

export const WIKILINK_DATA_ATTR = 'data-wikilink'

/** Matches a just-completed `[[Target]]` / `[[Target|alias]]` at the caret,
 *  for the live "typed closing bracket converts to a chip" input rule. */
const WIKILINK_INPUT_REGEX = /\[\[([^[\]]+)\]\]$/

export interface WikilinkAttrs {
  target: string
  label: string
}

interface WikilinkMarkdownItState {
  src: string
  pos: number
  push: (type: string, tag: string, nesting: number) => { meta?: unknown }
}

/**
 * markdown-it inline rule: recognises `[[...]]` before markdown-it's plain
 * text rule would otherwise swallow the brackets, and emits a `wikilink`
 * token carrying the parsed target/label. Registered in `parse.setup`
 * below. Exported standalone so the recognition logic has a direct test
 * against a bare `markdown-it` instance, no DOM required.
 */
export function wikilinkMarkdownItRule(state: WikilinkMarkdownItState, silent: boolean): boolean {
  const { src, pos } = state
  if (src.slice(pos, pos + 2) !== '[[') return false

  const end = src.indexOf(']]', pos + 2)
  if (end === -1) return false

  const inner = src.slice(pos + 2, end)
  if (!inner || inner.includes('\n')) return false

  if (!silent) {
    const { target, label } = parseWikilink(inner)
    const token = state.push('wikilink', '', 0)
    token.meta = { target, label }
  }

  state.pos = end + 2
  return true
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Renders a `wikilink` markdown-it token to the HTML span `tiptap-markdown`
 *  parses back into a `Wikilink` node. Exported standalone for the same
 *  reason as the rule above. */
export function renderWikilinkToken(tokens: { meta?: WikilinkAttrs }[], idx: number): string {
  const meta = tokens[idx].meta
  if (!meta) return ''
  return `<span ${WIKILINK_DATA_ATTR} data-target="${escapeAttr(meta.target)}">${escapeText(meta.label)}</span>`
}

/**
 * The markdown serializer for a `wikilink` node. Writes the raw `[[...]]`
 * text directly via `state.write()`, which is the load-bearing choice: it
 * bypasses `MarkdownSerializerState.esc()` entirely, so the brackets never
 * get backslash-escaped the way they would if this text went through the
 * normal text-node serialization path. Exported standalone so this
 * anti-escaping behaviour has a direct test.
 */
export function serializeWikilinkNode(
  state: { write: (text: string) => void },
  node: { attrs: WikilinkAttrs }
): void {
  const { target, label } = node.attrs
  const raw = label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`
  state.write(raw)
}

// Minimal shape of what markdown-it actually needs from us; the real
// `markdown-it` type is not imported here to keep this module import-light
// and DOM-free at the top level.
interface MarkdownItLike {
  inline: { ruler: { before: (before: string, name: string, rule: unknown) => void } }
  renderer: { rules: Record<string, unknown> }
}

export const Wikilink = Node.create({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      target: { default: '' },
      label: { default: '' },
    }
  },

  parseHTML() {
    return [
      {
        tag: `span[${WIKILINK_DATA_ATTR}]`,
        getAttrs: (element) => {
          const el = element as HTMLElement
          return {
            target: el.getAttribute('data-target') || '',
            label: el.textContent || '',
          }
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        [WIKILINK_DATA_ATTR]: '',
        'data-target': node.attrs.target,
        class: 'wikilink',
      }),
      node.attrs.label,
    ]
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: WIKILINK_INPUT_REGEX,
        type: this.type,
        getAttributes: (match) => {
          const { target, label } = parseWikilink(match[1])
          return { target, label }
        },
      }),
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize: serializeWikilinkNode,
        parse: {
          setup(markdownit: MarkdownItLike) {
            // `MarkdownParser.parse()` re-runs every extension's `setup()`
            // on its single, editor-lifetime `markdown-it` instance each
            // time content is parsed (once per note switch, since
            // `EditorPane` reuses one `Editor`). `ruler.before()` has no
            // built-in de-dup, so guard on the renderer rule (itself
            // idempotent to overwrite) to avoid piling up a duplicate
            // `wikilink` inline rule on every note switch.
            if (!markdownit.renderer.rules.wikilink) {
              markdownit.inline.ruler.before('text', 'wikilink', wikilinkMarkdownItRule)
            }
            markdownit.renderer.rules.wikilink = renderWikilinkToken
          },
        },
      },
    }
  },
})
