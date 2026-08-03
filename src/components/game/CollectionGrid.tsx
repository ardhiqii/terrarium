import type { CollectionEntry } from '@/lib/game/collection'
import { CreatureSprite } from './CreatureSprite'

/**
 * The pokedex grid: one tile per companion, sprite plus name plus stage.
 * Renders two kinds of entry (see `CollectionEntry.kind`):
 *
 * - `'repo'`: one creature per repo, species-assigned by language (T19).
 * - `'cluster'`: one companion per tag that reached `CLUSTER_THRESHOLD`
 *   notes (T22), species-assigned by theme (`species-assign.ts`'s cluster
 *   path). A cluster entry's `state` already carries the cluster's OWN
 *   inherited XP/stage (see `clusters.ts`), not a fresh stage 1.
 *
 * `isNew` (cluster entries only, derived rather than stored: see
 * `clusters.ts`) renders a small accent tag rather than anything louder.
 * The user's own framing for the hatch event was "discovery, not chance":
 * one accent, sharp edges, no confetti, per DESIGN.md section 6.
 *
 * Deliberately a SEPARATE section from the garden creature's specimen plate
 * (see `/companions/page.tsx`), never merged into one list. The garden
 * creature is driven by notes plus all commits and stays the main one;
 * everything in this grid is the collection that grows around it.
 * Flattening the two together would make the garden creature just one more
 * tile among many, which is exactly the thing DESIGN.md and the T19 spec
 * both rule out.
 */
export interface CollectionGridProps {
  entries: CollectionEntry[]
}

export async function CollectionGrid({ entries }: CollectionGridProps) {
  if (entries.length === 0) {
    return (
      <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
        No companions yet. Repo creatures appear once GitHub repo data is
        reachable at build time; cluster companions appear once a tag
        reaches five notes.
      </p>
    )
  }

  const tiles = await Promise.all(
    entries.map((entry) =>
      CreatureSprite({ stage: entry.state.stage.id, scale: 2, speciesLineId: entry.speciesLine.id })
    )
  )

  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
    >
      {entries.map((entry, i) => (
        <div
          key={`${entry.kind ?? 'repo'}-${entry.repo}`}
          className="relative flex flex-col items-center text-center gap-2 p-4"
          style={{
            background: 'var(--paper)',
            border: entry.isNew ? '1px solid var(--accent)' : '1px solid var(--rule)',
          }}
        >
          {entry.isNew && (
            <span
              className="absolute top-0 right-0 font-data text-[9px] uppercase tracking-widest px-1.5 py-0.5"
              style={{ background: 'var(--accent)', color: 'var(--paper)' }}
            >
              New
            </span>
          )}
          <div className="h-16 flex items-center justify-center [&_img]:max-h-full [&_img]:max-w-full [&_img]:w-auto [&_img]:h-auto [&_img]:object-contain">
            {tiles[i]}
          </div>
          <p className="font-ui text-xs font-medium truncate w-full" title={entry.repo}>
            {entry.kind === 'cluster' ? `#${entry.repo}` : entry.repo}
          </p>
          <p className="font-data text-[10px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            {entry.state.stage.name} · L{entry.state.stage.index}
          </p>
          <p className="font-data text-[10px]" style={{ color: 'var(--ink-muted)' }}>
            {entry.kind === 'cluster'
              ? `Cluster · ${entry.speciesLine.name}`
              : `${entry.language ?? 'unlabeled'} · ${entry.speciesLine.name}`}
          </p>
        </div>
      ))}
    </div>
  )
}
