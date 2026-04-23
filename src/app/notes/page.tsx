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
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-10">
        <h1 className="text-2xl font-semibold mb-2" style={{ fontFamily: 'Inter, sans-serif' }}>
          Notes
        </h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {notes.length} {notes.length === 1 ? 'note' : 'notes'} — short ideas, observations, and learnings.
        </p>
      </div>

      {notes.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No notes yet. Add an MDX file to <code className="text-xs">content/notes/</code>
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {notes.map((item) => (
            <ContentCard key={item.href} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
