/**
 * The shipped sprite cache against the species mapping.
 *
 * `species.test.ts` guards the MAPPING (the 649 animated ceiling, one real evolution family per
 * line, no shared languages). This file guards the other half, which nothing checked: the
 * committed `pokeapi-cache.json` that every client render actually reads. AGENTS.md names the
 * failure mode precisely — "the stale `pokeapi-cache.json` returning the OLD id for a changed
 * species mapping (cache keyed by line:stage, not id)" — and that is a silent one: the mapping
 * moves, the cache keeps the previous Pokémon, and every card renders the wrong creature with
 * no error anywhere.
 *
 * These assertions are over the real committed data, not fixtures, so they fail the moment the
 * two files disagree. No network, no `fs` reads outside the repo.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SPECIES_LINES } from './species'

interface CachedSprite {
  id: number
  url: string
  staticUrl?: string | null
  animated?: boolean
  evolutionChainId?: number | null
  isDefaultForm?: boolean
  formName?: string
}

const STAGES = ['sporeling', 'mossling', 'bracken', 'heartwood'] as const

const cache = JSON.parse(
  readFileSync(new URL('./pokeapi-cache.json', import.meta.url), 'utf8'),
) as Record<string, CachedSprite>

describe('the committed sprite cache matches the species mapping', () => {
  it('has an entry for exactly the mapped line/stage pairs', () => {
    const expected = SPECIES_LINES.flatMap((line) => STAGES.map((stage) => `${line.id}:${stage}`)).sort()
    expect(Object.keys(cache).sort()).toEqual(expected)
  })

  it('cached ids are the CURRENT mapping, not a stale previous one', () => {
    const stale: string[] = []
    for (const line of SPECIES_LINES) {
      for (const stage of STAGES) {
        const mapped = line.stageToPokemonId[stage]
        const cached = cache[`${line.id}:${stage}`]?.id
        if (cached !== mapped) stale.push(`${line.id}:${stage} mapping=${mapped} cache=${cached}`)
      }
    }
    expect(stale).toEqual([])
  })

  it('every cached URL points at its own id', () => {
    // A URL naming a different Pokémon renders someone else's creature: the id and the path
    // have to agree, and for a Mega the path is the static PNG because no animated sprite
    // exists above 649.
    const wrong: string[] = []
    for (const [key, entry] of Object.entries(cache)) {
      const expected = entry.id <= 649 ? `/${entry.id}.gif` : `/${entry.id}.png`
      if (!entry.url.endsWith(expected)) wrong.push(`${key} url=${entry.url}`)
      if (entry.staticUrl && !entry.staticUrl.endsWith(`/${entry.id}.png`)) {
        wrong.push(`${key} staticUrl=${entry.staticUrl}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('the animated flag agrees with the id ceiling', () => {
    const wrong = Object.entries(cache)
      .filter(([, entry]) => entry.animated !== (entry.id <= 649))
      .map(([key]) => key)
    expect(wrong).toEqual([])
  })

  it('every line resolves to ONE evolution chain, and no two lines share one', () => {
    // Two lines on the same family would put the same creature in the pool twice; a line split
    // across chains is the stitched-together data the species file's header says was fixed.
    const split = SPECIES_LINES
      .map((line) => ({ id: line.id, chains: new Set(STAGES.map((stage) => cache[`${line.id}:${stage}`]?.evolutionChainId)) }))
      .filter((line) => line.chains.size !== 1)
      .map((line) => line.id)
    expect(split).toEqual([])

    const owners = new Map<number, string[]>()
    for (const line of SPECIES_LINES) {
      const chain = cache[`${line.id}:sporeling`]?.evolutionChainId
      if (typeof chain !== 'number') continue
      owners.set(chain, [...(owners.get(chain) ?? []), line.id])
    }
    expect([...owners.entries()].filter(([, ids]) => ids.length > 1)).toEqual([])
  })

  it('stages 1-3 are default forms and the fourth is a Mega', () => {
    const wrong: string[] = []
    for (const line of SPECIES_LINES) {
      for (const stage of STAGES) {
        const entry = cache[`${line.id}:${stage}`]
        if (!entry) continue
        if (stage === 'heartwood') {
          if (entry.isDefaultForm) wrong.push(`${line.id}:heartwood is a default form`)
          if (!(entry.formName ?? '').includes('mega')) wrong.push(`${line.id}:heartwood form=${entry.formName}`)
        } else if (!entry.isDefaultForm) {
          wrong.push(`${line.id}:${stage} form=${entry.formName}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})
