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
}

export function XpBar({ xpIntoStage, xpForNextStage, progress }: XpBarProps) {
  const isMax = xpForNextStage === null
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100)

  return (
    <div className="w-full">
      <div
        className="h-2 w-full"
        style={{ background: 'var(--rule)' }}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={isMax ? 'Max stage reached' : `${xpIntoStage} of ${xpForNextStage} xp, ${pct} percent`}
        aria-label="Progress to next stage"
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
          {isMax ? 'max stage' : `${xpIntoStage} / ${xpForNextStage} xp`}
        </span>
        <span style={{ color: 'var(--ink-muted)' }}>{pct}%</span>
      </div>
    </div>
  )
}
