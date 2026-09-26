import type { Metadata } from 'next'
import { GitHubSourcePanel } from '@/components/game/GitHubSourcePanel'

export const metadata: Metadata = {
  title: 'GitHub source',
  description: 'Choose repositories and sync verified GitHub activity into your companion.',
}

export default function GitHubPage() {
  return <GitHubSourcePanel />
}
