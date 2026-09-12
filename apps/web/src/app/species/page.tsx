import type { Metadata } from 'next'
import { SPECIES_LINES } from '@/lib/game/sprites/species'
import { STAGES } from '@/lib/game/types'
import { slotLabel } from '@/lib/game/stages'
import { CreatureSprite } from '@/components/game/CreatureSprite'

export const metadata: Metadata = {
  title: 'Species gallery',
  description:
    'Every species line and every evolution stage, so the full sprite set is visible at a glance.',
}

/**
 * `/species` — a pokedex-style gallery of every Pokemon sprite in the sprite
 * system: all 8 species lines (grass, ember, current, tide, bedrock, venom,
 * psychic, steel, bloom) x all 4 stages (sporeling, mossling, bracken,
 * heartwood).
 *
 * Sprites resolve through the same `CreatureSprite` server component the rest
 * of the site uses, so each tile renders the real PokeAPI sprite when
 * reachable and falls back to the code-generated local sprite otherwise. Each
 * tile also carries the stage name, the actual Pokemon id, and its PokeAPI
 * name when cached, so the gallery doubles as a reference for the sprite
 * mappings in `species.ts`.
 */
export default function SpeciesGalleryPage() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-12">
        <p
          className="font-data text-xs uppercase tracking-widest mb-2"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          The sprite pool
        </p>
        <h1 className="font-ui text-3xl font-semibold tracking-tighter leading-[1.05] mb-3">
          Species gallery
        </h1>
        <p
          className="font-prose text-base leading-relaxed max-w-2xl"
          style={{ color: 'var(--ink-muted)' }}
        >
          Every species line and every evolution stage at a glance. Each row is
          one line; each column is one stage. Sprites pull from the animated
          Generation-V set where available, exact same source the creatures on
          the home page and /companions use.
        </p>
      </div>

      {/* Stage header row */}
      <div
        className="grid gap-3 mb-4"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
      >
        {STAGES.map((stage) => (
          <div key={stage.id} className="text-center">
            <p className="font-data text-[10px] uppercase tracking-widest" style={{ color: 'var(--ink-muted)' }}>
              {slotLabel(stage)}
            </p>
            <p className="font-ui text-sm font-semibold">{stage.name}</p>
          </div>
        ))}
      </div>

      {SPECIES_LINES.map((line) => (
        <SpeciesLineRow key={line.id} line={line} />
      ))}

      <div
        className="mt-10"
        style={{ borderTop: '1px solid var(--rule)' }}
      >
        <p className="font-prose text-xs mt-4" style={{ color: 'var(--ink-muted)' }}>
          The mappings above come from <code className="font-data">apps/web/src/lib/game/sprites/species.ts</code>.
          Language tags map a repository to its line for the collection view; the garden
          creature always renders the grass line.
        </p>
      </div>
    </div>
  )
}

async function SpeciesLineRow({ line }: { line: (typeof SPECIES_LINES)[number] }) {
  const sprites = await Promise.all(
    STAGES.map((stage) => CreatureSprite({ stage: stage.id, scale: 3, speciesLineId: line.id }))
  )

  return (
    <div className="mb-8">
      <div className="mb-3">
        <h2 className="font-ui text-lg font-semibold tracking-tighter">{line.name}</h2>
        <p className="font-prose text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          {line.theme}
        </p>
      </div>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
      >
        {STAGES.map((stage, i) => (
          <div
            key={`${line.id}-${stage.id}`}
            className="flex flex-col items-center text-center gap-2 p-4"
            style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}
          >
            <div className="h-24 flex items-center justify-center [&_img]:max-h-full [&_img]:max-w-full [&_img]:w-auto [&_img]:h-auto [&_img]:object-contain">
              {sprites[i]}
            </div>
            <p className="font-ui text-xs font-medium">
              #{line.stageToPokemonId[stage.id]}
            </p>
            <p className="font-data text-[10px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
              {stage.name}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
