'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import ThemeToggle from './ThemeToggle'
import GardenMark from '../GardenMark'

const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/notes', label: 'Notes' },
  { href: '/projects', label: 'Projects' },
  { href: '/graph', label: 'Graph' },
  { href: '/search', label: 'Search' },
]

export default function Navbar() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  return (
    <header
      className="sticky top-0 z-50 border-b"
      style={{ background: 'var(--background)', borderColor: 'var(--border)' }}
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
              className="text-sm font-semibold tracking-widest uppercase"
              style={{ fontFamily: 'Inter, sans-serif', letterSpacing: '0.1em' }}
            >
              ardhiqi<span style={{ color: 'var(--note-color)' }}>·</span>garden
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
                  className="px-3 py-1.5 rounded-md text-sm transition-colors"
                  style={{
                    color: isActive ? 'var(--foreground)' : 'var(--muted)',
                    background: isActive ? 'var(--tag-bg)' : 'transparent',
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
              className="p-1.5 rounded-md"
              style={{ color: 'var(--muted)' }}
              aria-label="Toggle menu"
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
          <nav className="sm:hidden pb-3 flex flex-col gap-1">
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
                  className="px-3 py-2 rounded-md text-sm"
                  style={{
                    color: isActive ? 'var(--foreground)' : 'var(--muted)',
                    background: isActive ? 'var(--tag-bg)' : 'transparent',
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
