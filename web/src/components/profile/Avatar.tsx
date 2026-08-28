'use client'

import { useState } from 'react'

/**
 * GitHub avatars, with a fallback. Avatars come from GitHub (a third party
 * this project does not control), so a 404, a rate-limited camo proxy, or a
 * plain missing URL must never break a profile or leaderboard row's layout.
 * `onError` needs a client component, which is why this one small piece is
 * `'use client'` while everything around it stays a server component, the
 * same "small client island" pattern `ThemeToggle` and `SearchClient` use
 * elsewhere in this codebase.
 */
export interface AvatarProps {
  src: string | null
  /** GitHub handle, used for the accessible label and the fallback glyph. */
  handle: string
  /** Pixel size, square. */
  size?: number
}

export default function Avatar({ src, handle, size = 40 }: AvatarProps) {
  const [failed, setFailed] = useState(false)

  const showFallback = !src || failed

  if (showFallback) {
    return (
      <div
        className="flex items-center justify-center shrink-0 font-data uppercase"
        style={{
          width: size,
          height: size,
          fontSize: size * 0.4,
          background: 'var(--paper-raised)',
          border: '1px solid var(--rule)',
          color: 'var(--ink-muted)',
        }}
        aria-label={`${handle}'s avatar (unavailable)`}
      >
        {handle.slice(0, 1)}
      </div>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- an avatar URL is
    // an arbitrary external host (GitHub's), which next/image cannot
    // optimize without allow-listing every possible camo/avatar host.
    <img
      src={src}
      alt={`${handle}'s GitHub avatar`}
      width={size}
      height={size}
      className="shrink-0"
      style={{ width: size, height: size, border: '1px solid var(--rule)', objectFit: 'cover' }}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
    />
  )
}
