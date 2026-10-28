/**
 * Progress through the current evolution stage. Pure presentation: given
 * numbers in, a bar and a fraction out. No data fetching here.
 *
 * At max stage `xpForNextStage` is null by contract (CreatureState). Rather
 * than divide by it or print "NaN", this renders a completed state: the bar
 * full and a "max stage" label instead of a fraction.
 */
export interface XpBarProps {
  xpIntoStage: number
  /** null at max stage. */
  xpForNextStage: number | null
  /** 0..1. Exactly 1 at max stage. */
  progress: number
  /**
   * The stage these numbers are INSIDE. Rendered into the visible label.
   *
   * WHY THIS EXISTS: the bar read "50 / 3500 xp" while the observation log a few rows below
   * read "Total 1550 xp". Both were correct -- 1550 total, 1500 to enter Mossling, so 50 into
   * it against a 3500-wide stage -- but nothing on screen said the fraction was XP WITHIN the
   * stage rather than the running total. A reader with two unexplained numbers concludes one
   * of them is a bug. Naming the stage makes the fraction self-describing.
   */
  stageName?: string
}

export function XpBar({ xpIntoStage, xpForNextStage, progress, stageName }: XpBarProps) {
  const isMax = xpForNextStage === null
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100)
  const target = stageName ?? 'this stage'

  return (
    <div className="w-full">
      <div
        className="h-2 w-full"
        style={{ background: 'var(--rule)' }}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={
          isMax
            ? 'Max stage reached'
            : `${xpIntoStage} of ${xpForNextStage} xp into ${target}, ${pct} percent`
        }
        aria-label="Progress into this stage"
      >
        <div
          className="h-full"
          style={{
            width: `${pct}%`,
            background: 'var(--accent)',
          }}
        />
      </div>
      <div className="font-data flex items-baseline justify-between mt-1.5 text-xs">
        <span style={{ color: 'var(--ink-muted)' }}>
          {isMax
            ? 'max stage'
            : `${xpIntoStage.toLocaleString()} of ${xpForNextStage.toLocaleString()} xp into ${target}`}
        </span>
        <span style={{ color: 'var(--ink-muted)' }}>{pct}%</span>
      </div>
    </div>
  )
}
