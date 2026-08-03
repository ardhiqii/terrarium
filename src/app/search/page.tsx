import { getAllContent } from '@/lib/content'
import SearchClient from '@/components/search/SearchClient'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Search',
}

export default function SearchPage() {
  const allContent = getAllContent()

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-10">
        <h1 className="font-ui text-2xl font-semibold mb-2">
          Search
        </h1>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          Search across {allContent.length} notes and projects.
        </p>
      </div>

      <SearchClient items={allContent} />
    </div>
  )
}
