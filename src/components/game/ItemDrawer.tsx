import type { ItemState } from '@/lib/game/types'
import { getSprite } from '@/lib/game/sprites'
import Sprite from './Sprite'

/**
 * All seven items, rendered as a specimen drawer. Unlocked items show their
 * sprite at full opacity with the name. Locked items are dimmed and show
 * the requirement plus progress as a percentage: the requirement text is the
 * engagement hook, so it must stay legible rather than reading as a silhouette
 * mystery.
 *
 * Cell count matches item count at every breakpoint. This used to be a fixed
 * `grid-cols-2 sm:grid-cols-4` with a `gap-px` background mesh standing in
 * for hairlines, which left a visible empty tile after item 7 at both
 * breakpoints (the mesh painted the empty grid cell as a hole). Fixed by
 * dropping the mesh technique entirely: `auto-fill` sizes columns to
 * whatever fits the container, and each item draws its own `--rule` border
 * instead of relying on a painted gap. A short last row is then just
 * trailing whitespace, not a phantom tile, and the layout stays correct
 * regardless of how many items exist (T9 may add more).
 */
export interface ItemDrawerProps {
  items: ItemState[]
}

export function ItemDrawer({ items }: ItemDrawerProps) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}
    >
      {items.map((item) => {
        const sprite = getSprite(item.def.sprite)
        const pct = Math.round(Math.min(1, Math.max(0, item.progress)) * 100)

        return (
          <div
            key={item.def.id}
            className="flex flex-col items-center text-center gap-2 p-4"
            style={{
              background: 'var(--paper)',
              border: '1px solid var(--rule)',
              opacity: item.unlocked ? 1 : 0.45,
            }}
          >
            <div className="h-16 flex items-center justify-center">
              {sprite && (
                <Sprite
                  sprite={sprite}
                  scale={2}
                  alt={item.unlocked ? item.def.name : `${item.def.name}, locked`}
                />
              )}
            </div>
            <p className="font-ui text-xs font-medium" style={{ color: 'var(--ink)' }}>
              {item.def.name}
              {!item.unlocked && (
                <span
                  className="font-data ml-1.5 text-[9px] uppercase tracking-wide align-middle"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  Locked
                </span>
              )}
            </p>
            <p
              className="font-data text-[11px] leading-snug"
              style={{ color: 'var(--ink-muted)' }}
            >
              {item.unlocked ? item.def.requirement : `${item.def.requirement} (${pct}%)`}
            </p>
          </div>
        )
      })}
    </div>
  )
}
