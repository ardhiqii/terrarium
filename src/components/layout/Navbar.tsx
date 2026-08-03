'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import ThemeToggle from './ThemeToggle'
import GardenMark from '../GardenMark'
import { siteConfig } from '@/lib/site-config'

const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/notes', label: 'Notes' },
  { href: '/projects', label: 'Projects' },
  { href: '/companions', label: 'Companions' },
  { href: '/garden', label: 'Garden' },
  { href: '/graph', label: 'Graph' },
  { href: '/search', label: 'Search' },
]

export default function Navbar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

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
                  className="font-ui px-3 py-1.5 text-sm transition-colors"
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
            <div className="ml-2">
              <ThemeToggle />
            </div>
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
          </nav>
        )}
      </div>
    </header>
  )
}
