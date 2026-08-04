'use client'

/**
 * The account cluster at the right end of the Navbar.
 *
 * WHY THIS EXISTS AS ITS OWN THING. Signing in used to add a Leaderboard link
 * *and* a "Sign out" button directly into the nav row. The header is capped at
 * `max-w-4xl`, so that pushed it to eleven items and "Sign out" wrapped onto
 * two lines. The structural problem was not the wrap: it was that the primary
 * navigation changed width depending on who you were.
 *
 * So signed-in-only destinations live in here instead. The nav row is now the
 * same eight links for everyone, and everything account-shaped is one compact
 * control behind a divider. Nothing reflows at sign in.
 */

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface AccountMenuProps {
  signedIn: boolean
  handle: string | null
  avatarUrl: string | null
  onSignOut: () => void
  /** Rendered as a flat list rather than a dropdown, for the mobile sheet. */
  variant?: 'menu' | 'inline'
}

// `ui-row` carries the hover tint and the pointer cursor (see globals.css).
// Without it these read as plain text: there is no underline, no cursor
// change, and no background, so nothing says "clickable" until you click.
const ITEM_CLASS = 'ui-row font-ui block w-full text-left px-3 py-2 text-sm whitespace-nowrap'

export default function AccountMenu({
  signedIn,
  handle,
  avatarUrl,
  onSignOut,
  variant = 'menu',
}: AccountMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    // Focus goes back to the trigger on Escape, so keyboard users are not
    // dumped at the top of the document. Not on outside-click, where the
    // user has already chosen somewhere else to be.
    if (returnFocus) buttonRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) close(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close(true)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  // Signed out. One quiet control, deliberately not styled as a call to
  // action: this is a personal garden that reads fine without an account.
  if (!signedIn) {
    return (
      // A plain anchor, not next/link: this leaves the app for github.com via
      // a server redirect, so client-side navigation would break the flow.
      <a
        href="/api/auth/login"
        className="font-ui px-3 py-1.5 text-sm whitespace-nowrap transition-colors hover:opacity-70"
        style={{ color: 'var(--ink-muted)' }}
      >
        Sign in
      </a>
    )
  }

  const signedInLinks = (
    <>
      <Link href="/leaderboard" role="menuitem" className={ITEM_CLASS} style={{ color: 'var(--ink)' }}>
        Leaderboard
      </Link>
      <Link href={`/u/${handle}`} role="menuitem" className={ITEM_CLASS} style={{ color: 'var(--ink)' }}>
        Your profile
      </Link>
      <button
        type="button"
        role="menuitem"
        onClick={onSignOut}
        className={ITEM_CLASS}
        style={{ color: 'var(--ink-muted)' }}
      >
        Sign out
      </button>
    </>
  )

  // The mobile sheet has room to breathe, so a nested dropdown there would be
  // interaction for its own sake. Same links, laid out flat.
  if (variant === 'inline') {
    return (
      <div className="flex flex-col border-t mt-2 pt-2" style={{ borderColor: 'var(--rule)' }}>
        <span
          className="font-mono px-3 py-1 text-xs uppercase tracking-wider"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.08em' }}
        >
          {handle}
        </span>
        {signedInLinks}
      </div>
    )
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${handle}`}
        className="flex items-center gap-1.5 px-1.5 py-1 rounded transition-colors"
        style={{ background: open ? 'var(--paper-raised)' : 'transparent' }}
      >
        <Avatar handle={handle} avatarUrl={avatarUrl} />
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          aria-hidden="true"
          style={{ color: 'var(--ink-muted)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          onClick={() => close(false)}
          className="absolute right-0 mt-1 min-w-44 py-1 border shadow-sm"
          style={{
            background: 'var(--paper-raised)',
            borderColor: 'var(--rule)',
            borderRadius: '4px',
          }}
        >
          <span
            className="font-mono block px-3 py-1.5 text-xs uppercase tracking-wider border-b mb-1"
            style={{
              color: 'var(--ink-muted)',
              borderColor: 'var(--rule)',
              letterSpacing: '0.08em',
            }}
          >
            {handle}
          </span>
          {signedInLinks}
        </div>
      )}
    </div>
  )
}

/**
 * The avatar, or a monogram when GitHub gave us no URL.
 *
 * The monogram fallback is not decoration: `Session.avatarUrl` is genuinely
 * nullable, and an empty box next to a caret does not read as "you".
 */
function Avatar({ handle, avatarUrl }: { handle: string | null; avatarUrl: string | null }) {
  const size = 22

  if (avatarUrl) {
    return (
      // A plain img, not next/image: this is one 22px avatar from an origin
      // that would otherwise need a remotePatterns entry in next.config, and
      // the optimizer earns nothing at this size.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        className="rounded-full"
        style={{ width: size, height: size, objectFit: 'cover' }}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className="font-mono flex items-center justify-center rounded-full text-xs"
      style={{
        width: size,
        height: size,
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
      }}
    >
      {(handle ?? '?').charAt(0).toUpperCase()}
    </span>
  )
}
