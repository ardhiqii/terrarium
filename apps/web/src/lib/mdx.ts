import { compileMDX } from 'next-mdx-remote/rsc'
import remarkGfm from 'remark-gfm'
import rehypePrettyCode from 'rehype-pretty-code'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import { buildWikilinkMap } from './backlinks'
import { WIKILINK_REGEX, parseWikilink, slugify } from './utils'
import { visit } from 'unist-util-visit'
import type { ReactElement } from 'react'

export interface TocEntry {
  id: string
  text: string
  level: number
}

/**
 * Custom remark plugin to transform [[Title]] into markdown links.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function remarkWikilinks(): (tree: any) => void {
  const wikilinkMap = buildWikilinkMap()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visit(tree, 'text', (node: any, index: number | undefined, parent: any) => {
      if (!parent || index === undefined) return

      const regex = new RegExp(WIKILINK_REGEX.source, 'g')
      const text: string = node.value
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = []
      let lastIndex = 0

      let match: RegExpExecArray | null
      while ((match = regex.exec(text)) !== null) {
        // Supports both [[Title]] and [[Title|display text]].
        const { target, label } = parseWikilink(match[1])
        const href = wikilinkMap.get(target.toLowerCase()) ?? `#${slugify(target)}`

        if (match.index > lastIndex) {
          parts.push({ type: 'text', value: text.slice(lastIndex, match.index) })
        }

        parts.push({
          type: 'link',
          url: href,
          title: null,
          children: [{ type: 'text', value: label }],
          data: { hProperties: { className: ['wikilink'] } },
        })

        lastIndex = match.index + match[0].length
      }

      if (parts.length === 0) return
      if (lastIndex < text.length) {
        parts.push({ type: 'text', value: text.slice(lastIndex) })
      }

      parent.children.splice(index, 1, ...parts)
    })
  }
}

/** Extract TOC headings from raw MDX content */
export function extractToc(content: string): TocEntry[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm
  const toc: TocEntry[] = []
  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length
    const text = match[2].trim()
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
    toc.push({ id, text, level })
  }
  return toc
}

/** Compile MDX content string into a React component */
export async function renderMDX(content: string): Promise<ReactElement> {
  const { content: rendered } = await compileMDX({
    source: content,
    options: {
      mdxOptions: {
        remarkPlugins: [remarkGfm, remarkWikilinks],
        rehypePlugins: [
          rehypeSlug,
          [
            rehypeAutolinkHeadings,
            {
              behavior: 'wrap',
              properties: { className: ['anchor'] },
            },
          ],
          [
            rehypePrettyCode,
            {
              theme: {
                dark: 'github-dark',
                light: 'github-light',
              },
              keepBackground: false,
            },
          ],
        ],
      },
    },
  })
  return rendered
}
