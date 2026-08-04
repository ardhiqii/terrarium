import type { Maturity } from '@/lib/game/types'

/**
 * Maturity renders as a neutral weight ramp plus a glyph, per DESIGN.md 2.1.
 * Never three hues. Absent maturity reads as 'seedling'.
 */
const GLYPH: Record<Maturity, string> = {
  seedling: '○', // hollow circle
  budding: '◐', // half circle
  evergreen: '●', // filled circle
}

const WEIGHT: Record<Maturity, number> = {
  seedling: 400,
  budding: 500,
  evergreen: 600,
}

const COLOR: Record<Maturity, string> = {
  seedling: 'var(--ink-muted)',
  budding: 'var(--ink-muted)',
  evergreen: 'var(--ink)',
}

interface MaturityMarkProps {
  maturity?: Maturity
  className?: string
  /**
   * Glyph without the word, for dense list rows.
   *
   * In a sidebar the word is repeated on every line and, in a young garden
   * where everything is a seedling, it is the same word every time. Three
   * glyphs are an ordinal ramp (empty, half, full) that reads at a glance
   * and forms a scannable column; the word is kept for the editor header,
   * where there is exactly one note and it costs nothing. The label is still
   * announced to assistive tech either way.
   */
  glyphOnly?: boolean
}

export default function MaturityMark({
  maturity,
  className = '',
  glyphOnly = false,
}: MaturityMarkProps) {
  const m = maturity ?? 'seedling'

  return (
    <span
      className={`font-data inline-flex items-center gap-1 text-xs uppercase tracking-wide ${className}`}
      style={{ color: COLOR[m], fontWeight: WEIGHT[m] }}
    >
      <span aria-hidden="true">{GLYPH[m]}</span>
      {glyphOnly ? <span className="sr-only">{m}</span> : m}
    </span>
  )
}
