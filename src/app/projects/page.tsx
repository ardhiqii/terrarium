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
        <h1 className="font-ui text-2xl font-semibold mb-2">
          Projects
        </h1>
        <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
          {projects.length} {projects.length === 1 ? 'project' : 'projects'}. Things built, shipped, or in progress.
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="border border-dashed p-10 text-center" style={{ borderColor: 'var(--rule)' }}>
          <p className="font-ui text-sm" style={{ color: 'var(--ink-muted)' }}>
            No projects yet. Add an MDX file to <code className="font-data text-xs">content/projects/</code>
          </p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-[color:var(--rule)]">
          {projects.map((item) => (
            <ContentCard key={item.href} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}
