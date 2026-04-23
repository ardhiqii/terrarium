import { getCollectionContent } from '@/lib/content'
import ContentCard from '@/components/ContentCard'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Projects',
  description: 'Things I have built, shipped, or am working on.',
}

export default function ProjectsPage() {
  const projects = getCollectionContent('projects')

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-10">
        <h1 className="text-2xl font-semibold mb-2" style={{ fontFamily: 'Inter, sans-serif' }}>
          Projects
        </h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {projects.length} {projects.length === 1 ? 'project' : 'projects'} — things built, shipped, or in progress.
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No projects yet. Add an MDX file to <code className="text-xs">content/projects/</code>
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((item) => (
            <ContentCard key={item.href} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
