import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SPECIES_LINES } from '@/lib/game/sprites/species'
import { STAGES } from '@/lib/game/types'
import { resolveWithFallback } from '@/lib/game/sprites/source'
import PreviewStage, {
  type PreviewLine,
  type PreviewStage as PreviewStageType,
} from '@/components/game/PreviewStage'

export const metadata: Metadata = {
  title: 'Preview',
  description:
    'Interactive creature preview. Pick a species line and cycle through its evolution stages.',
}

/**
 * `/preview` — an interactive single-character preview. One framed container
 * shows a creature; you switch species line with the picker and cycle the
 * evolution stage with the 1..4 buttons.
 *
 * All sprite data is resolved ONCE here server-side (every line x every stage,
 * through the same `resolveWithFallback` the rest of the site uses, so it keeps
 * the PokeAPI-with-local-fallback behaviour), serialized into plain props, and
 * handed to the client `PreviewStage` component. The client component does no
 * fetching and no fs access; it only swaps which pre-resolved sprite to show.
 *
 * Walk/run/sleep states do not exist in this sprite set (PokeAPI has idle
 * animations only), so the only interactive dimension is evolution stage and
 * species line.
 */
export default async function PreviewPage() {
  const lines: PreviewLine[] = await Promise.all(
    SPECIES_LINES.map(async (line) => {
      const stages = await Promise.all(
        STAGES.map(async (stage) => {
          const resolved = await resolveWithFallback(stage.id, undefined, line.id)
          if (resolved.kind === 'remote') {
            return {
              url: resolved.url,
              staticUrl: resolved.staticUrl,
              width: resolved.width,
              height: resolved.height,
              animated: resolved.animated,
              pokemonId: line.stageToPokemonId[stage.id],
            }
          }
          // Local code-generated fallback. No remote URL to show.
          return {
            url: null,
            staticUrl: null,
            width: resolved.data.width,
            height: resolved.data.height,
            animated: false,
            pokemonId: line.stageToPokemonId[stage.id],
          }
        })
      )
      return { id: line.id, name: line.name, theme: line.theme, stages }
    })
  )

  const stageMeta: PreviewStageType[] = STAGES.map((stage) => ({
    id: stage.id,
    name: stage.name,
    index: stage.index,
    slot: stage.slot,
  }))

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16">
      <div className="mb-10">
        <p
          className="font-data text-xs uppercase tracking-widest mb-2"
          style={{ color: 'var(--ink-muted)', letterSpacing: '0.15em' }}
        >
          Interactive preview
        </p>
        <h1 className="font-ui text-3xl font-semibold tracking-tighter leading-[1.05] mb-3">
          Preview
        </h1>
        <p
          className="font-prose text-base leading-relaxed max-w-2xl"
          style={{ color: 'var(--ink-muted)' }}
        >
          One creature at a time. Pick a species line, then tap a number to
          step through its evolution stages. Animated sprites are the PokeAPI
          idle set; walk/run/sleep states aren&apos;t in this sprite pool.
        </p>
      </div>

      <Suspense>
        <PreviewStage lines={lines} stages={stageMeta} />
      </Suspense>
    </div>
  )
}
