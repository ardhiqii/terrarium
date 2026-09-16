import { redirect } from 'next/navigation'

export default function ProjectsPage() {
  // Keep old bookmarks and home-page links useful while the Notes workspace
  // becomes the single index for written projects.
  redirect('/notes#projects')
}
