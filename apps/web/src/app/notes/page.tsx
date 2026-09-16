import Link from 'next/link'
import type { Metadata } from 'next'
import { getCollectionContent } from '@/lib/content'
import ContentCard from '@/components/ContentCard'

export const metadata: Metadata = {
  title: 'Notes',
  description: 'Browse notes and written projects, or start writing in your mounted folder.',
}

export default function NotesPage() {
  const notes = getCollectionContent('notes')
  const projects = getCollectionContent('projects')

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6 mb-10">
        <div>
          <p
            className="font-data text-xs font-semibold uppercase tracking-widest mb-3"
            style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
          >
            Writing space
          </p>
          <h1 className="font-ui text-3xl font-semibold tracking-tight mb-2">
            Notes
          </h1>
          <p className="font-ui text-sm leading-relaxed max-w-xl" style={{ color: 'var(--ink-muted)' }}>
            Browse notes and written projects in one place. Start a new note in your mounted folder when an idea arrives.
          </p>
        </div>

        <Link
          href="/write"
          className="ui-row inline-flex items-center justify-center self-start sm:self-auto px-4 py-2.5 font-ui text-sm font-medium border"
          style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
        >
          <span aria-hidden="true" className="mr-2 text-base leading-none">+</span>
          New note
        </Link>
      </header>

      <div
        className="font-data flex flex-wrap items-center gap-x-4 gap-y-2 py-3 mb-10 border-y text-xs uppercase tracking-wide"
        style={{ borderColor: 'var(--rule)', color: 'var(--ink-muted)' }}
      >
        <span>{notes.length} {notes.length === 1 ? 'note' : 'notes'}</span>
        <span style={{ color: 'var(--rule)' }} aria-hidden="true">.</span>
        <span>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</span>
        <span style={{ color: 'var(--rule)' }} aria-hidden="true">.</span>
        <span>Published writing</span>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_280px] gap-12 lg:gap-16">
        <section aria-labelledby="notes-heading">
          <div className="flex items-baseline justify-between gap-4 mb-2">
            <h2 id="notes-heading" className="font-ui text-lg font-semibold">
              Notes
            </h2>
            <span className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
              Recent thinking
            </span>
          </div>
          <p className="font-ui text-sm leading-relaxed mb-4" style={{ color: 'var(--ink-muted)' }}>
            Short ideas, observations, and learnings.
          </p>

          {notes.length === 0 ? (
            <EmptyCollection
              title="No notes yet"
              description="Start with a small idea and let the garden grow from there."
              action="Create a note"
            />
          ) : (
            <div className="flex flex-col divide-y divide-[color:var(--rule)]">
              {notes.map((item) => (
                <ContentCard key={item.href} item={item} />
              ))}
            </div>
          )}
        </section>

        <section id="projects" aria-labelledby="projects-heading">
          <div className="flex items-baseline justify-between gap-4 mb-2">
            <h2 id="projects-heading" className="font-ui text-lg font-semibold">
              Projects
            </h2>
            <span className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
              Written work
            </span>
          </div>
          <p className="font-ui text-sm leading-relaxed mb-4" style={{ color: 'var(--ink-muted)' }}>
            Longer pieces, build notes, and things taking shape.
          </p>

          {projects.length === 0 ? (
            <EmptyCollection
              title="No projects yet"
              description="Written projects will appear here when they are added to the project collection."
            />
          ) : (
            <div className="flex flex-col divide-y divide-[color:var(--rule)] border-t" style={{ borderColor: 'var(--rule)' }}>
              {projects.map((item) => (
                <ContentCard key={item.href} item={item} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function EmptyCollection({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: string
}) {
  return (
    <div className="border border-dashed p-6" style={{ borderColor: 'var(--rule)' }}>
      <p className="font-ui text-sm font-medium mb-1">{title}</p>
      <p className="font-ui text-sm leading-relaxed mb-4" style={{ color: 'var(--ink-muted)' }}>
        {description}
      </p>
      {action && (
        <Link href="/write" className="font-data text-xs uppercase tracking-wide" style={{ color: 'var(--accent)' }}>
          {action} <span aria-hidden="true">→</span>
        </Link>
      )}
    </div>
  )
}
