'use client'

import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { MATURITIES, type Maturity } from '@/lib/game/types'

/** Same glyphs as `MaturityMark.tsx`, so this control reads as the same
 *  vocabulary as every other maturity indicator on the site. */
const GLYPH: Record<Maturity, string> = {
  seedling: '○',
  budding: '◐',
  evergreen: '●',
}

interface MaturitySegmentedProps {
  value: Maturity
  onChange: (maturity: Maturity) => void
  className?: string
}

/**
 * Three-option segmented control replacing the native `<select>` for
 * maturity (T25 problem 2). Maturity has exactly three, ordered values, so a
 * segmented control reads better than a dropdown and, critically, never
 * renders OS chrome the theme cannot touch.
 *
 * `role="radiogroup"` + one `role="radio"` per option, roving tabindex, and
 * arrow-key navigation between options, per WAI-ARIA's radio group pattern.
 * State is shown by border/weight/glyph, never colour alone.
 */
export default function MaturitySegmented({ value, onChange, className = '' }: MaturitySegmentedProps) {
  const buttonRefs = useRef<Partial<Record<Maturity, HTMLButtonElement | null>>>({})

  function focusIndex(index: number) {
    const wrapped = MATURITIES[(index + MATURITIES.length) % MATURITIES.length]
    buttonRefs.current[wrapped]?.focus()
    onChange(wrapped)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      focusIndex(index + 1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusIndex(index - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusIndex(MATURITIES.length - 1)
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Maturity"
      className={`inline-flex font-data text-xs uppercase tracking-wide ${className}`}
    >
      {MATURITIES.map((m, index) => {
        const selected = m === value
        return (
          <button
            key={m}
            ref={(el) => {
              buttonRefs.current[m] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(m)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className="flex items-center gap-1.5 px-2.5 py-1 border transition-colors"
            style={{
              borderColor: selected ? 'var(--accent)' : 'var(--rule)',
              color: selected ? 'var(--accent)' : 'var(--ink-muted)',
              fontWeight: selected ? 600 : 400,
              marginLeft: index === 0 ? 0 : -1,
              background: selected ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <span aria-hidden="true">{GLYPH[m]}</span>
            {m}
          </button>
        )
      })}
    </div>
  )
}
