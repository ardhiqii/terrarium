'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import ThemeToggle from './ThemeToggle'
import AccountMenu from './AccountMenu'
import { isAppShellRoute } from '@/lib/app-shell-routes'
import GardenMark from '../GardenMark'
import { siteConfig } from '@/lib/site-config'

/**
 * Eight flat items became six, and the order changed. What moved and why:
 *
 * "Home" is gone. The wordmark beside it already links to `/`, so it was two
 * controls for one destination burning a scarce slot.
 *
 * "Search" left the row for an icon in the utility cluster. Search is a
 * utility, not a place: `/search` reads the same corpus `/notes` does, so
 * giving it equal weight implied a content area that does not exist.
 *
 * "Garden" became "Write", and this was the worst label on the site. It had
 * no information scent at all: "garden" is the product's own metaphor, so as
 * a label it named everything and therefore nothing, and someone clicking it
 * expecting the garden got an OS folder picker. "Write" is a verb whose
 * outcome you can predict, and it sits next to Notes so the pair reads as
 * read/create. It stays in the primary row rather than moving behind the
 * account divider, deliberately: adding a note is the thing that must be
 * discoverable, and a menu is where discoverability goes to die.
 *
 * Guide and Graph are no longer adjacent. With Garden also in the row these
 * were three same-length G words in a block, and nav is scanned by word
 * shape, so they read as one blur.
 */
const BASE_NAV_LINKS = [
  { href: '/notes', label: 'Notes' },
  { href: '/write', label: 'Write' },
  { href: '/projects', label: 'Projects' },
  { href: '/graph', label: 'Graph' },
  { href: '/companions', label: 'Companions' },
  { href: '/guide', label: 'Guide' },
]

/**
 * Search, as an icon in the utility cluster rather than a peer of Notes.
 *
 * `/search` reads the same corpus `/notes` and `/projects` do, so giving it a
 * content-level slot advertised a section that does not exist. The magnifier
 * is one of the few genuinely universal icons, but it still carries a real
 * `aria-label` and a `title`, so it is never icon-only to a screen reader or
 * to someone who hovers to check.
 */
function SearchLink({ pathname }: { pathname: string }) {
  const isActive = pathname.startsWith('/search')
  return (
    <Link
      href="/search"
      aria-label="Search"
      title="Search"
      aria-current={isActive ? 'page' : undefined}
      data-active={isActive}
      className="ui-row flex items-center justify-center p-1.5 rounded"
      style={{ color: isActive ? 'var(--ink)' : 'var(--ink-muted)' }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    </Link>
  )
}

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

  // Full-bleed chrome on routes that own the viewport. See the container below.
  const appShell = isAppShellRoute(pathname)

  // The same six links for everyone, signed in or not. Leaderboard and the
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
      {/* The chrome aligns with the widest thing on the page, which is the
          rule every app-plus-content product follows (Linear, Notion, Vercel
          docs). Content wider than its chrome reads as a bug; chrome slightly
          wider than content reads as deliberate.

          On an app-shell route that widest thing is the viewport, so the bar
          goes edge to edge and its gutter matches the editor's own
          `px-4 sm:px-6`, putting the wordmark, the folder name in the status
          strip, and the sidebar on one shared left edge.

          Elsewhere it is a centered column. `max-w-5xl` rather than the old
          `max-w-4xl` because /graph and /companions are 1024px wide and were
          overhanging the header by 64px per side, which is the failure
          direction that actually looks broken. */}
      <div className={appShell ? 'px-4 sm:px-6' : 'max-w-5xl mx-auto px-4 sm:px-6'}>
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
          <nav aria-label="Main" className="hidden sm:flex items-center gap-1">
            {NAV_LINKS.map((link) => {
              const isActive =
                link.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(link.href)
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="ui-row font-ui px-2.5 py-1.5 text-sm whitespace-nowrap rounded"
                  data-active={isActive}
                  // Announces the current page to a screen reader. Previously
                  // the only signals were colour and font weight, neither of
                  // which is exposed to assistive tech at all.
                  aria-current={isActive ? 'page' : undefined}
                  style={{
                    color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                    fontWeight: isActive ? 500 : 400,
                    // A non-colour active affordance, so the current page is
                    // not signalled by hue alone. Inset rather than a border
                    // so it cannot shift the row by a pixel.
                    boxShadow: isActive ? 'inset 0 -2px 0 var(--accent)' : undefined,
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
            <SearchLink pathname={pathname} />
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
          <nav
            id="mobile-nav"
            aria-label="Main, mobile"
            className="sm:hidden pb-3 flex flex-col gap-1"
          >
            {/* Search appears as a labelled row here rather than the icon the
                desktop row uses. There is space for the word, and an icon
                alone in a vertical list has no affordance to lean on. */}
            {[...NAV_LINKS, { href: '/search', label: 'Search' }].map((link) => {
              const isActive =
                link.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(link.href)
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="ui-row font-ui px-3 py-2 text-sm rounded"
                  data-active={isActive}
                  aria-current={isActive ? 'page' : undefined}
                  style={{
                    color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                    fontWeight: isActive ? 500 : 400,
                    boxShadow: isActive ? 'inset 2px 0 0 var(--accent)' : undefined,
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
