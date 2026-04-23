import { getAllContent, getAllTags } from '@/lib/content'
import ContentCard from '@/components/ContentCard'
import GardenLogo from '@/components/GardenLogo'
import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: "Ardhiqi's Garden",
  description: "Aufa's digital garden — notes, projects, and ideas in various states of growth.",
}

export default function HomePage() {
  const allContent = getAllContent()
  const tags = getAllTags()

  const noteCount = allContent.filter((i) => i.type === 'note').length
  const projectCount = allContent.filter((i) => i.type === 'project').length

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6">

      {/* ── Hero ── */}
      <section className="flex flex-col items-center text-center pt-20 pb-16">
        <GardenLogo markSize={80} className="mb-6" />

        <p
          className="text-base leading-relaxed max-w-md mt-4"
          style={{ color: 'var(--muted)' }}
        >
          I&apos;m <strong style={{ color: 'var(--foreground)' }}>Aufa</strong> — this is where I pour
          out ideas, document things I&apos;ve built, and think out loud.
          Notes are messy. Projects are real. Everything connects.
        </p>

        {/* Stats */}
        <div className="flex items-center gap-3 mt-8 flex-wrap justify-center">
          <Link
            href="/notes"
            className="flex items-center gap-2 px-4 py-2 rounded-full border text-sm transition-all hover:shadow-sm"
            style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: 'var(--note-color)' }}
            />
            <span style={{ color: 'var(--muted)' }}>{noteCount} notes</span>
          </Link>

          <Link
            href="/projects"
            className="flex items-center gap-2 px-4 py-2 rounded-full border text-sm transition-all hover:shadow-sm"
            style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: 'var(--project-color)' }}
            />
            <span style={{ color: 'var(--muted)' }}>{projectCount} projects</span>
          </Link>

          <Link
            href="/tags"
            className="flex items-center gap-2 px-4 py-2 rounded-full border text-sm transition-all hover:shadow-sm"
            style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
          >
            <span style={{ color: 'var(--muted)' }}>{tags.length} tags</span>
          </Link>

          <Link
            href="/graph"
            className="flex items-center gap-2 px-4 py-2 rounded-full border text-sm transition-all hover:shadow-sm"
            style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: 'var(--muted)' }}>
              <circle cx="5" cy="12" r="2.5" />
              <circle cx="19" cy="5" r="2.5" />
              <circle cx="19" cy="19" r="2.5" />
              <line x1="7.5" y1="12" x2="16.5" y2="6" />
              <line x1="7.5" y1="12" x2="16.5" y2="18" />
            </svg>
            <span style={{ color: 'var(--muted)' }}>explore graph</span>
          </Link>
        </div>
      </section>

      {/* Divider */}
      <div className="border-t" style={{ borderColor: 'var(--border)' }} />

      {/* ── Feed ── */}
      <section className="py-12">
        <h2
          className="text-xs font-semibold uppercase tracking-widest mb-6"
          style={{ color: 'var(--muted)', letterSpacing: '0.15em' }}
        >
          Recent
        </h2>

        {allContent.length === 0 ? (
          <div
            className="rounded-xl border border-dashed p-12 text-center"
            style={{ borderColor: 'var(--border)' }}
          >
            <p className="font-medium mb-1">The garden is empty</p>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Add your first note to <code className="text-xs">content/notes/</code> or project to{' '}
              <code className="text-xs">content/projects/</code>
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {allContent.map((item) => (
              <ContentCard key={item.href} item={item} />
            ))}
          </div>
        )}
      </section>

    </div>
  )
}
