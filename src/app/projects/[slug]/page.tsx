import { notFound } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { getAllSlugs, getContentItem } from '@/lib/content'
import { getBacklinks } from '@/lib/backlinks'
import { renderMDX, extractToc } from '@/lib/mdx'
import TableOfContents from '@/components/layout/TableOfContents'
import Backlinks from '@/components/Backlinks'
import MaturityMark from '@/components/MaturityMark'
import type { Metadata } from 'next'

interface Props {
  params: Promise<{ slug: string }>
}

export async function generateStaticParams() {
  return getAllSlugs('projects')
}

export const dynamicParams = false

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const item = getContentItem('projects', slug)
  if (!item) return {}
  return {
    title: item.title,
    description: item.description,
  }
}

export default async function ProjectPage({ params }: Props) {
  const { slug } = await params
  const item = getContentItem('projects', slug)
  if (!item) notFound()

  const [mdxContent, backlinks, toc] = await Promise.all([
    renderMDX(item.content),
    Promise.resolve(getBacklinks(slug)),
    Promise.resolve(extractToc(item.content)),
  ])

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
      {/* Breadcrumb */}
      <nav className="font-ui mb-8 text-sm" style={{ color: 'var(--ink-muted)' }}>
        <Link href="/" className="hover:opacity-70 transition-opacity">Home</Link>
        <span className="mx-2">.</span>
        <Link href="/projects" className="hover:opacity-70 transition-opacity">Projects</Link>
      </nav>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-16">
        {/* Main content */}
        <article>
          {/* Cover image */}
          {item.image && (
            <div className="mb-8 overflow-hidden border" style={{ borderColor: 'var(--rule)' }}>
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
            <div className="font-data flex items-center gap-2 mb-3 text-xs uppercase tracking-wide flex-wrap">
              <span className="font-medium" style={{ color: 'var(--accent)' }}>
                project
              </span>
              <span style={{ color: 'var(--rule)' }}>.</span>
              <time style={{ color: 'var(--ink-muted)' }} dateTime={item.date}>
                {new Date(item.date).toLocaleDateString('en-US', {
                  year: 'numeric', month: 'long', day: 'numeric',
                })}
              </time>
              <MaturityMark maturity={item.maturity} className="ml-auto" />
            </div>
            <h1 className="font-ui text-3xl font-semibold tracking-tight mb-3">
              {item.title}
            </h1>
            {item.description && (
              <p className="font-ui text-base" style={{ color: 'var(--ink-muted)' }}>
                {item.description}
              </p>
            )}
            {item.tags.length > 0 && (
              <div className="font-data flex flex-wrap gap-2 mt-4 text-xs uppercase tracking-wide">
                {item.tags.map((tag) => (
                  <Link
                    key={tag}
                    href={`/tags/${tag}`}
                    className="border px-2.5 py-1 transition-colors hover:border-[color:var(--ink-muted)]"
                    style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
                  >
                    {tag}
                  </Link>
                ))}
              </div>
            )}
          </header>

          {/* MDX body */}
          <div className="prose prose-base">
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
