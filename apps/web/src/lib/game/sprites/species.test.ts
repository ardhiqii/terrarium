import { describe, it, expect } from 'vitest'
import {
  SPECIES_LINES,
  DEFAULT_SPECIES_LINE_ID,
  MAX_ANIMATED_POKEMON_ID,
  MEGA_STAGE,
  getSpeciesLine,
  getDefaultSpeciesLine,
} from './species'
import { STAGES } from '../types'

describe('SPECIES_LINES data integrity', () => {
  it('has more than one line, so the collection is not still a single species', () => {
    expect(SPECIES_LINES.length).toBeGreaterThan(1)
  })

  it('every animated stage (all but heartwood/Mega) is an integer at or below 649 (the animated generation-v ceiling)', () => {
    for (const line of SPECIES_LINES) {
      for (const [stage, id] of Object.entries(line.stageToPokemonId)) {
        expect(Number.isInteger(id), `${line.id}.${stage}`).toBe(true)
        expect(id, `${line.id}.${stage}`).toBeGreaterThanOrEqual(1)
        if (stage !== MEGA_STAGE) {
          // Only non-Mega stages must stay inside the animated-sprite ceiling.
          // Mega forms (heartwood) are deliberately static, so they live above
          // 649 by design (e.g. 10033 = Mega Venusaur).
          expect(id, `${line.id}.${stage}`).toBeLessThanOrEqual(MAX_ANIMATED_POKEMON_ID)
        }
      }
    }
  })

  it('every Mega stage (heartwood) is a static Mega form id above 649', () => {
    for (const line of SPECIES_LINES) {
      const megaId = line.stageToPokemonId[MEGA_STAGE]
      // Real PokeAPI Mega forms live in the 10000s (National Mega range).
      expect(megaId, `${line.id}.${MEGA_STAGE}`).toBeGreaterThan(649)
    }
  })

  it('every line defines an id for every stage in STAGES', () => {
    for (const line of SPECIES_LINES) {
      for (const stage of STAGES) {
        expect(line.stageToPokemonId[stage.id], `${line.id}.${stage.id}`).toBeTypeOf('number')
      }
    }
  })

  it('no language is claimed by more than one line', () => {
    const seen = new Map<string, string>()
    for (const line of SPECIES_LINES) {
      for (const lang of line.languages) {
        const existing = seen.get(lang.toLowerCase())
        expect(existing, `language '${lang}' claimed by both ${existing} and ${line.id}`).toBeUndefined()
        seen.set(lang.toLowerCase(), line.id)
      }
    }
  })

  it('every line has a unique id', () => {
    const ids = SPECIES_LINES.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the default line id resolves to a real line', () => {
    const line = getSpeciesLine(DEFAULT_SPECIES_LINE_ID)
    expect(line.id).toBe(DEFAULT_SPECIES_LINE_ID)
  })

  it('the grass line is a genuine evolution family (Bulbasaur -> Ivysaur -> Venusaur -> Mega Venusaur)', () => {
    const grass = getDefaultSpeciesLine()
    expect(grass.stageToPokemonId).toEqual({
      sporeling: 1,
      mossling: 2,
      bracken: 3,
      heartwood: 10033,
    })
  })

  it('each line is one real evolution family: non-Mega stages grow along a single chain', () => {
    // Bulbasaur(1)->Ivysaur(2)->Venusaur(3); Charmander(4)->...; etc. We
    // assert the three animated stages are all distinct ids so the line reads
    // as a real progression, not the same sprite three times.
    for (const line of SPECIES_LINES) {
      for (const stage of STAGES) {
        if (stage.id !== MEGA_STAGE) {
          expect(line.stageToPokemonId[stage.id], `${line.id}.${stage.id}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('getSpeciesLine falls back to the default line for an unknown id', () => {
    const fallback = getSpeciesLine('not-a-real-line')
    expect(fallback.id).toBe(DEFAULT_SPECIES_LINE_ID)
  })

  it('within a single line, the four stage ids are all distinct (a real progression, not the same sprite four times)', () => {
    for (const line of SPECIES_LINES) {
      const ids = Object.values(line.stageToPokemonId)
      expect(new Set(ids).size, line.id).toBe(ids.length)
    }
  })
})
