import type { CreatureState, SpriteScale } from '@/lib/game/types'
import { resolveVariant } from '@/lib/game/variants'
import { CreatureSprite } from './CreatureSprite'
import { XpBar } from './XpBar'

/**
 * The mounted-object moment. This is the one place in the project where a
 * card with elevation is allowed (DESIGN.md 2.3): a specimen mounted on a
 * plate is exactly what elevation should communicate here. Framed with a
 * 1px --rule border and no radius, per the archive shape language.
 */
export interface SpecimenPlateProps {
  state: CreatureState
  /** Sprite display scale. Default 3. */
  scale?: SpriteScale
}

export async function SpecimenPlate({ state, scale = 3 }: SpecimenPlateProps) {
  // Pure and cheap: derived straight from data this component already has,
  // no fetch, no fs. See variants.ts for thresholds and precedence.
  const variant = resolveVariant(state.stats, state.github)

  return (
    <div
      className="p-6 sm:p-8"
      style={{
        background: 'var(--paper-raised)',
        border: '1px solid var(--rule)',
        boxShadow: '0 2px 12px -4px rgba(20, 20, 22, 0.12)',
      }}
    >
      <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 items-center sm:items-start">
        {/*
          Must match the companions, which also renders through CreatureSprite.
          Rendering the local sprite here instead showed a different creature
          for the same stage on the two pages.
        */}
        <div className="shrink-0 flex items-center justify-center">
          <CreatureSprite
            stage={state.stage.id}
            scale={scale}
            alt={state.stage.name}
          />
        </div>

        <div className="flex-1 w-full">
          <p
            className="font-data text-xs uppercase tracking-widest mb-1"
            style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
          >
            Specimen {state.stage.index} of 4
          </p>
          <h2 className="font-ui text-2xl font-semibold tracking-tighter leading-[1.05] mb-2">
            {state.stage.name}
            {variant && (
              <>
                {'  ·  '}
                <span className="font-data text-lg" style={{ color: 'var(--accent)' }}>
                  var. {variant}
                </span>
              </>
            )}
          </h2>
          <p
            className="font-prose text-sm leading-relaxed mb-5"
            style={{ color: 'var(--ink-muted)' }}
          >
            {state.stage.blurb}
          </p>

          <XpBar
            xpIntoStage={state.xpIntoStage}
            xpForNextStage={state.xpForNextStage}
            progress={state.progress}
          />
        </div>
      </div>
    </div>
  )
}
