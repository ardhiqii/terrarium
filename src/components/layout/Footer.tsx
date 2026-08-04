'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isAppShellRoute } from '@/lib/app-shell-routes'
import { siteConfig, wordmarkText } from '@/lib/site-config'

export default function Footer() {
  const pathname = usePathname()
  // No page footer under an app shell: it would give the document a second
  // scroll axis, so you could scroll the whole editor away while typing.
  // The route list is shared with the Navbar, which uses it to go full bleed.
  if (isAppShellRoute(pathname)) {
    return null
  }

  return (
    <footer
      className="border-t mt-20 py-10"
      style={{ borderColor: 'var(--rule)' }}
    >
      <div
        className="font-ui max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm"
        style={{ color: 'var(--ink-muted)' }}
      >
        <p>
          {siteConfig.ownerName
            ? `${siteConfig.ownerName}. Ideas in various states of growth.`
            : `${wordmarkText()}. Ideas in various states of growth.`}
        </p>
        <nav className="flex gap-4">
          <Link href="/graph" className="hover:opacity-70 transition-opacity">Graph</Link>
          <Link href="/tags" className="hover:opacity-70 transition-opacity">Tags</Link>
          <Link href="/search" className="hover:opacity-70 transition-opacity">Search</Link>
        </nav>
      </div>
    </footer>
  )
}
