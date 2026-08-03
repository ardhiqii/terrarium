import { describe, it, expect } from 'vitest'
import {
  SPECIES_LINES,
  DEFAULT_SPECIES_LINE_ID,
  MAX_ANIMATED_POKEMON_ID,
  getSpeciesLine,
  getDefaultSpeciesLine,
} from './species'
import { STAGES } from '../types'

describe('SPECIES_LINES data integrity', () => {
  it('has more than one line, so the collection is not still a single species', () => {
    expect(SPECIES_LINES.length).toBeGreaterThan(1)
  })

  it('every id in every line is a positive integer at or below 649 (the animated generation-v ceiling)', () => {
    for (const line of SPECIES_LINES) {
      for (const [stage, id] of Object.entries(line.stageToPokemonId)) {
        expect(Number.isInteger(id), `${line.id}.${stage}`).toBe(true)
        expect(id, `${line.id}.${stage}`).toBeGreaterThanOrEqual(1)
        expect(id, `${line.id}.${stage}`).toBeLessThanOrEqual(MAX_ANIMATED_POKEMON_ID)
      }
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

  it('the grass line matches the original single-species mapping exactly, so the garden creature is unaffected', () => {
    const grass = getDefaultSpeciesLine()
    expect(grass.stageToPokemonId).toEqual({
      sporeling: 191,
      mossling: 43,
      bracken: 2,
      heartwood: 389,
    })
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
