import { notFound } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { getAllSlugs, getContentItem } from '@/lib/content'
import { getBacklinks } from '@/lib/backlinks'
import { renderMDX, extractToc } from '@/lib/mdx'
import TableOfContents from '@/components/layout/TableOfContents'
import Backlinks from '@/components/Backlinks'
import type { Metadata } from 'next'

interface Props {
  params: Promise<{ slug: string }>
}

export async function generateStaticParams() {
  return getAllSlugs('notes')
}

export const dynamicParams = false

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const item = getContentItem('notes', slug)
  if (!item) return {}
  return {
    title: item.title,
    description: item.description,
  }
}

export default async function NotePage({ params }: Props) {
  const { slug } = await params
  const item = getContentItem('notes', slug)
  if (!item) notFound()

  const [mdxContent, backlinks, toc] = await Promise.all([
    renderMDX(item.content),
    Promise.resolve(getBacklinks(slug)),
    Promise.resolve(extractToc(item.content)),
  ])

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
      {/* Breadcrumb */}
      <nav className="mb-8 text-sm" style={{ color: 'var(--muted)' }}>
        <Link href="/" className="hover:opacity-70 transition-opacity">Home</Link>
        <span className="mx-2">·</span>
        <Link href="/notes" className="hover:opacity-70 transition-opacity">Notes</Link>
      </nav>

      <div className="lg:grid lg:grid-cols-[1fr_200px] lg:gap-12">
        {/* Main content */}
        <article>
          {/* Cover image */}
          {item.image && (
            <div className="mb-8 rounded-xl overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
              <Image
                src={item.image}
                alt={item.title}
                width={1200}
                height={600}
                className="w-full h-auto"
                style={{ display: 'block' }}
              />
            </div>
          )}

          {/* Header */}
          <header className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(74,124,89,0.1)', color: 'var(--note-color)' }}
              >
                note
              </span>
              <time className="text-xs" style={{ color: 'var(--muted)' }} dateTime={item.date}>
                {new Date(item.date).toLocaleDateString('en-US', {
                  year: 'numeric', month: 'long', day: 'numeric',
                })}
              </time>
            </div>
            <h1
              className="text-3xl font-semibold tracking-tight mb-3"
              style={{ fontFamily: 'Inter, sans-serif' }}
            >
              {item.title}
            </h1>
            {item.description && (
              <p className="text-base" style={{ color: 'var(--muted)' }}>
                {item.description}
              </p>
            )}
            {item.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {item.tags.map((tag) => (
                  <Link
                    key={tag}
                    href={`/tags/${tag}`}
                    className="text-xs px-2.5 py-1 rounded-lg transition-opacity hover:opacity-70"
                    style={{ background: 'var(--tag-bg)', color: 'var(--tag-text)' }}
                  >
                    {tag}
                  </Link>
                ))}
              </div>
            )}
          </header>

          {/* MDX body */}
          <div className="prose prose-base max-w-none">
            {mdxContent}
          </div>

          {/* Backlinks */}
          <Backlinks backlinks={backlinks} />
        </article>

        {/* Sidebar: TOC */}
        <aside className="hidden lg:block">
          <div className="sticky top-20">
            <TableOfContents entries={toc} />
          </div>
        </aside>
      </div>
    </div>
  )
}
