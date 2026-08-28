import { describe, expect, it } from 'vitest'
import {
  createCompanionCatalog,
  PROTOTYPE_COMPANION_CATALOG,
  resolveCompanionProgression,
  type CompanionDefinition,
} from './companion-catalog'

describe('companion catalog', () => {
  it('keeps the game provider-neutral while configuring real PokeAPI references', () => {
    expect(PROTOTYPE_COMPANION_CATALOG.list()).toHaveLength(2)
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
    expect(resolveCompanionProgression(definition, 100).step.id).toBe('evolved')
    expect(resolveCompanionProgression(definition, 100).progress).toBe(1)
    expect(resolveCompanionProgression(definition, 100).form.name).toBe('Raichu')
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
