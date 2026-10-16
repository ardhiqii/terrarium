import { describe, expect, it } from 'vitest'
import {
  COMPANION_PROGRESSION_THRESHOLDS,
  createCompanionCatalog,
  getStarterCandidates,
  isStarterEligible,
  PROTOTYPE_COMPANION_CATALOG,
  resolveCompanionProgression,
  selectStarterCompanion,
  type CompanionDefinition,
} from './companion-catalog'

describe('companion catalog', () => {
  it('keeps the game provider-neutral while configuring real PokeAPI references', () => {
    expect(PROTOTYPE_COMPANION_CATALOG.list()).toHaveLength(3)
    const pikachuFamily = PROTOTYPE_COMPANION_CATALOG.get('pikachu-family')!
    expect(pikachuFamily.forms[0].provider.providerId).toBe('pokeapi')
    expect(pikachuFamily.forms[0].provider.entityId).toBe('pikachu')
    expect(pikachuFamily.forms[0].provider.metadata?.evolutionChainId).toBe(10)
    expect(pikachuFamily.forms[0].staticAsset?.key).toContain('pokeapi:pokemon:pikachu')
    expect(pikachuFamily.forms[0].animatedAsset?.variant).toBe('animated')
  })

  it('resolves base, evolved, and max progression without inventing stages', () => {
    const definition = PROTOTYPE_COMPANION_CATALOG.get('pikachu-family')!
    expect(resolveCompanionProgression(definition, 0).form.id).toBe('base')
    expect(resolveCompanionProgression(definition, 50).nextStep?.id).toBe('evolved')
    expect(resolveCompanionProgression(definition, COMPANION_PROGRESSION_THRESHOLDS.mossling).step.id).toBe('evolved')
    expect(resolveCompanionProgression(definition, COMPANION_PROGRESSION_THRESHOLDS.mossling).progress).toBe(1)
    expect(resolveCompanionProgression(definition, COMPANION_PROGRESSION_THRESHOLDS.mossling).form.name).toBe('Raichu')
  })

  it('maps the canonical Grass family to the four locked provider forms and thresholds', () => {
    const grass = PROTOTYPE_COMPANION_CATALOG.get('grass-family')!
    expect(grass.starterEligible).toBe(true)
    expect(grass.legacyLine).toBe('grass')
    expect(grass.forms.map((form) => [form.name, form.provider.entityId, form.provider.formId])).toEqual([
      ['Sporeling', 'bulbasaur', '1'],
      ['Mossling', 'ivysaur', '2'],
      ['Bracken', 'venusaur', '3'],
      ['Heartwood', 'venusaur-mega', '10033'],
    ])
    expect(grass.progression.map((step) => step.threshold)).toEqual([0, 1500, 5000, 12000])
    expect(grass.forms[3].animatedAsset).toBeUndefined()
    expect(grass.forms[3].staticAsset?.variant).toBe('static')
  })

  it('filters starters to explicit base-stage definitions and accepts injected RNG', () => {
    expect(getStarterCandidates(PROTOTYPE_COMPANION_CATALOG).map((entry) => entry.id)).toEqual([
      'pikachu-family',
      'ditto-like',
      'grass-family',
    ])
    expect(selectStarterCompanion(PROTOTYPE_COMPANION_CATALOG, () => 0).id).toBe('pikachu-family')
    expect(selectStarterCompanion(PROTOTYPE_COMPANION_CATALOG, () => 0.999).id).toBe('grass-family')
    expect(isStarterEligible(PROTOTYPE_COMPANION_CATALOG, 'grass-family')).toBe(true)
    expect(isStarterEligible(PROTOTYPE_COMPANION_CATALOG, 'missing')).toBe(false)

    const notEligible = {
      ...PROTOTYPE_COMPANION_CATALOG.get('pikachu-family')!,
      id: 'not-eligible',
      starterEligible: false,
    }
    const catalog = createCompanionCatalog([notEligible])
    expect(getStarterCandidates(catalog)).toEqual([])
    expect(() => selectStarterCompanion(catalog, () => 0)).toThrow(/no eligible/)
  })

  it('rejects duplicate identities and invalid progression references', () => {
    const valid = PROTOTYPE_COMPANION_CATALOG.get('pikachu-family')!
    expect(() => createCompanionCatalog([valid, valid])).toThrow(/duplicate companion ID/)

    const invalid: CompanionDefinition = {
      ...valid,
      id: 'invalid',
      progression: [{ ...valid.progression[0], formId: 'missing' }],
    }
    expect(() => createCompanionCatalog([invalid])).toThrow(/references missing form/)
  })

  it('requires explicit form kinds and strictly increasing thresholds', () => {
    const valid = PROTOTYPE_COMPANION_CATALOG.get('pikachu-family')!
    const wrongKind: CompanionDefinition = {
      ...valid,
      id: 'wrong-kind',
      progression: [
        { ...valid.progression[0] },
        { ...valid.progression[1], kind: 'mastery' },
      ],
    }
    expect(() => createCompanionCatalog([wrongKind])).toThrow(/kind must match/)

    const repeatedThreshold: CompanionDefinition = {
      ...valid,
      id: 'repeated-threshold',
      progression: [
        { ...valid.progression[0] },
        { ...valid.progression[1], threshold: 0 },
      ],
    }
    expect(() => createCompanionCatalog([repeatedThreshold])).toThrow(/strictly increasing/)
  })
})
