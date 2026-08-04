'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import ThemeToggle from './ThemeToggle'
import AccountMenu from './AccountMenu'
import GardenMark from '../GardenMark'
import { siteConfig } from '@/lib/site-config'

const BASE_NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/notes', label: 'Notes' },
  { href: '/projects', label: 'Projects' },
  { href: '/companions', label: 'Companions' },
  { href: '/guide', label: 'Guide' },
  { href: '/garden', label: 'Garden' },
  { href: '/graph', label: 'Graph' },
  { href: '/search', label: 'Search' },
]

/** The shape `/api/auth/session` answers with. */
interface SessionInfo {
  signedIn: boolean
  handle: string | null
  avatarUrl: string | null
  /** False when the server has no GitHub OAuth app configured. */
  configured: boolean
}

export default function Navbar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  // Null means "not resolved yet", which is different from "signed out" and
  // is why this is not just a boolean: until the fetch lands, neither the
  // Leaderboard link nor a sign in control is rendered, so the nav never
  // flickers a control that then disappears.
  //
  // The session is fetched here rather than passed down from the root layout
  // on purpose. Reading a cookie server-side in a layout opts every route in
  // the site into dynamic rendering (see the comment in app/layout.tsx), and
  // one nav link is not worth un-prerendering the whole garden for.
  const [session, setSession] = useState<SessionInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SessionInfo | null) => {
        if (!cancelled && data) setSession(data)
      })
      .catch(() => {
        // Signed out is the right answer when the endpoint is unreachable.
        // A nav bar must never be the thing that breaks a page.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } catch {
      // Fall through to the reload regardless: if the request failed the
      // cookie is still there, and the reload makes that visible rather than
      // leaving the nav claiming a sign out that did not happen.
    }
    // A full reload, not a router refresh, because server-rendered pages such
    // as /leaderboard read the session at request time.
    window.location.reload()
  }, [])

  // The same eight links for everyone, signed in or not. Leaderboard and the
  // profile used to be appended here when signed in, which made the nav row
  // reflow at sign in and pushed "Sign out" into a two-line wrap. They live in
  // the account menu now.
  const NAV_LINKS = BASE_NAV_LINKS

  // Rendered only once the session has resolved, so the header never flashes
  // a control that then changes.
  const accountMenu =
    session && session.configured ? (
      <AccountMenu
        signedIn={session.signedIn}
        handle={session.handle}
        avatarUrl={session.avatarUrl}
        onSignOut={signOut}
      />
    ) : null

  return (
    <header
      className="sticky top-0 z-50 border-b"
      style={{ background: 'var(--paper)', borderColor: 'var(--rule)' }}
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-14">
          {/* Logo */}
          <Link
            href="/"
            className="flex items-center gap-2.5 hover:opacity-70 transition-opacity"
          >
            <GardenMark size={24} />
            <span
              className="font-ui text-sm font-semibold tracking-widest uppercase"
              style={{ letterSpacing: '0.1em' }}
            >
              {siteConfig.wordmark.lead}
              <span style={{ color: 'var(--accent)' }}>
                {siteConfig.wordmark.separator}
              </span>
              {siteConfig.wordmark.trail}
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden sm:flex items-center gap-1">
            {NAV_LINKS.map((link) => {
              const isActive =
                link.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(link.href)
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="font-ui px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors"
                  style={{
                    color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                    background: isActive ? 'var(--paper-raised)' : 'transparent',
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  {link.label}
                </Link>
              )
            })}
            {/* Navigation ends here. Everything past the rule is about the
                viewer rather than the garden, and the divider is what makes
                that legible without a second row or a heavier treatment. */}
            <div
              aria-hidden="true"
              className="mx-2 h-4 w-px shrink-0"
              style={{ background: 'var(--rule)' }}
            />
            {accountMenu}
            <ThemeToggle />
          </nav>

          {/* Mobile: theme + hamburger */}
          <div className="flex sm:hidden items-center gap-2">
            <ThemeToggle />
            <button
              onClick={() => setOpen(!open)}
              className="p-1.5"
              style={{ color: 'var(--ink-muted)' }}
              aria-label="Toggle menu"
              aria-expanded={open}
              aria-controls="mobile-nav"
            >
              {open ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {open && (
          <nav id="mobile-nav" className="sm:hidden pb-3 flex flex-col gap-1">
            {NAV_LINKS.map((link) => {
              const isActive =
                link.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(link.href)
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="font-ui px-3 py-2 text-sm"
                  style={{
                    color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                    background: isActive ? 'var(--paper-raised)' : 'transparent',
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  {link.label}
                </Link>
              )
            })}
            {session && session.configured && (
              <AccountMenu
                signedIn={session.signedIn}
                handle={session.handle}
                avatarUrl={session.avatarUrl}
                onSignOut={signOut}
                variant="inline"
              />
            )}
          </nav>
        )}
      </div>
    </header>
  )
}
