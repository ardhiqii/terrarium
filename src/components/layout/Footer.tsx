'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { siteConfig, wordmarkText } from '@/lib/site-config'

/**
 * Routes that own the full viewport and must not have a page footer below
 * them. /write is an editor shell: its sidebar and prose each scroll
 * independently, and a footer underneath would give the document a second
 * scroll axis, so you could scroll the whole app away while typing. That is
 * the bug this list exists to prevent, not a styling preference.
 */
const APP_SHELL_ROUTES = ['/write']

export default function Footer() {
  const pathname = usePathname()
  if (APP_SHELL_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'))) {
    return null
  }

  return (
    <footer
      className="border-t mt-20 py-10"
      style={{ borderColor: 'var(--rule)' }}
    >
      <div
        className="font-ui max-w-4xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm"
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
