import { getAllTags, getContentByTag } from '@/lib/content'
import ContentCard from '@/components/ContentCard'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'

interface Props {
  params: Promise<{ tag: string }>
}

export async function generateStaticParams() {
  return getAllTags().map((tag) => ({ tag }))
}

export const dynamicParams = false

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tag } = await params
  return { title: `#${tag}` }
}

export default async function TagPage({ params }: Props) {
  const { tag } = await params
  const allTags = getAllTags()
  if (!allTags.includes(tag)) notFound()

  const items = getContentByTag(tag)

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
      <nav className="font-ui mb-8 text-sm" style={{ color: 'var(--ink-muted)' }}>
        <Link href="/tags" className="hover:opacity-70 transition-opacity">Tags</Link>
      </nav>

      <div className="mb-10">
        <h1 className="font-ui text-2xl font-semibold mb-2">
          #{tag}
        </h1>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </p>
      </div>

      <div className="flex flex-col divide-y divide-[color:var(--rule)]">
        {items.map((item) => (
          <ContentCard key={item.href} item={item} />
        ))}
      </div>
    </div>
  )
}
