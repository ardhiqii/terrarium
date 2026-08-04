import { getCollectionContent } from '@/lib/content'
import ContentCard from '@/components/ContentCard'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Notes',
  description: 'Short ideas, thoughts, and observations.',
}

export default function NotesPage() {
  const notes = getCollectionContent('notes')

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-10">
        <h1 className="font-ui text-2xl font-semibold mb-2">
          Notes
        </h1>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          {notes.length} {notes.length === 1 ? 'note' : 'notes'}. Short ideas, observations, and learnings.
        </p>
      </div>

      {notes.length === 0 ? (
        <div className="border border-dashed p-10 text-center" style={{ borderColor: 'var(--rule)' }}>
          <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
            No notes yet. Add an MDX file to <code className="font-data text-xs">content/notes/</code>
          </p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-[color:var(--rule)]">
          {notes.map((item) => (
            <ContentCard key={item.href} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
