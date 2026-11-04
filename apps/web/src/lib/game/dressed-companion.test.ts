import { describe, expect, it } from 'vitest'
import { PROTOTYPE_COMPANION_CATALOG } from './companion-catalog'
import { resolveDressedCompanion, type DressedSnapshot } from './dressed-companion'
import { opaqueReferenceId } from '../sync/product-snapshot'

/**
 * The read-side rule for a dressed repository (docs-plan/PLAN-dressed-repo-creature.md).
 * The snapshot is user-written, so every claim it makes is checked again here.
 */

const NOW = '2026-11-04T00:00:00.000Z'

function entry(rawReference: string, companionId: string) {
  // The snapshot stores collection references hashed, exactly as buildProductSnapshot does.
  return { referenceId: opaqueReferenceId(rawReference), companionId, acquiredAt: NOW, acquisition: 'encounter' }
}

function assignment(repositoryId: string, rawReference: string, companionId = 'pikachu-family') {
  // Assignments are copied verbatim, so they carry the RAW reference.
  return { repositoryId, referenceId: rawReference, companionId, assignedAt: NOW }
}

function snapshot(parts: Partial<Record<keyof DressedSnapshot, unknown[]>>): DressedSnapshot {
  return {
    collection: parts.collection ?? [],
    companions: parts.companions ?? [],
    assignments: parts.assignments ?? [],
  } as unknown as DressedSnapshot
}

const resolve = (snap: DressedSnapshot, repo = '101') =>
  resolveDressedCompanion(snap, repo, PROTOTYPE_COMPANION_CATALOG)

describe('resolveDressedCompanion', () => {
  it('matches a raw assignment reference against the hashed collection reference', () => {
    const dressed = resolve(
      snapshot({
        collection: [entry('guest-1:starter', 'pikachu-family')],
        companions: [{ companionId: 'pikachu-family', xp: 40 }],
        assignments: [assignment('101', 'guest-1:starter')],
      }),
    )
    expect(dressed).not.toBeNull()
    expect(dressed!.companionId).toBe('pikachu-family')
    expect(dressed!.name).toBe(PROTOTYPE_COMPANION_CATALOG.get('pikachu-family')!.name)
    expect(dressed!.step).toMatchObject({ id: 'base', index: 1, count: 2 })
    expect(dressed!.xpForNextStep).toBe(100)
    expect(dressed!.progress).toBeCloseTo(0.4)
  })

  it('also matches an assignment that already carries the opaque reference', () => {
    const dressed = resolve(
      snapshot({
        collection: [entry('guest-1:starter', 'pikachu-family')],
        assignments: [assignment('101', opaqueReferenceId('guest-1:starter'))],
      }),
    )
    expect(dressed?.companionId).toBe('pikachu-family')
  })

  it('returns null for a repository that is not dressed', () => {
    expect(
      resolve(
        snapshot({
          collection: [entry('r1', 'pikachu-family')],
          assignments: [assignment('202', 'r1')],
        }),
      ),
    ).toBeNull()
  })

  it('ignores an assignment whose companion is not in the collection', () => {
    expect(resolve(snapshot({ assignments: [assignment('101', 'never-drawn')] }))).toBeNull()
  })

  it('counts a companion spent on two repositories only for the first', () => {
    const snap = snapshot({
      collection: [entry('r1', 'pikachu-family')],
      assignments: [assignment('202', 'r1'), assignment('101', 'r1')],
    })
    expect(resolve(snap, '202')).not.toBeNull()
    expect(resolve(snap, '101')).toBeNull()
  })

  it('keeps only the first assignment for a repository listed twice', () => {
    const dressed = resolve(
      snapshot({
        collection: [entry('r1', 'pikachu-family'), entry('r2', 'bulbasaur-line')],
        assignments: [assignment('101', 'r1'), assignment('101', 'r2', 'bulbasaur-line')],
      }),
    )
    expect(dressed?.companionId).toBe('pikachu-family')
  })

  it('takes the species from the collection, not from the assignment', () => {
    const dressed = resolve(
      snapshot({
        collection: [entry('r1', 'pikachu-family')],
        // A forged assignment claiming a rarer species for a Pikachu.
        assignments: [assignment('101', 'r1', 'bulbasaur-line')],
      }),
    )
    expect(dressed?.companionId).toBe('pikachu-family')
  })

  it('treats NaN, negative and missing XP as zero', () => {
    for (const xp of [Number.NaN, -50, undefined]) {
      const dressed = resolve(
        snapshot({
          collection: [entry('r1', 'pikachu-family')],
          companions: xp === undefined ? [] : [{ companionId: 'pikachu-family', xp }],
          assignments: [assignment('101', 'r1')],
        }),
      )
      expect(dressed?.xp).toBe(0)
      expect(dressed?.step.index).toBe(1)
    }
  })

  it('reaches the final step exactly on its threshold and stays there past it', () => {
    for (const xp of [100, 10_000]) {
      const dressed = resolve(
        snapshot({
          collection: [entry('r1', 'pikachu-family')],
          companions: [{ companionId: 'pikachu-family', xp }],
          assignments: [assignment('101', 'r1')],
        }),
      )
      expect(dressed?.step).toMatchObject({ id: 'evolved', index: 2, count: 2 })
      expect(dressed?.xpForNextStep).toBeNull()
      expect(dressed?.progress).toBe(1)
    }
  })

  it('returns null for a species the catalog does not know', () => {
    expect(
      resolve(
        snapshot({
          collection: [entry('r1', 'not-a-companion')],
          assignments: [assignment('101', 'r1', 'not-a-companion')],
        }),
      ),
    ).toBeNull()
  })

  it('exposes nothing that identifies the collection entry', () => {
    const dressed = resolve(
      snapshot({
        collection: [entry('guest-1:starter', 'pikachu-family')],
        assignments: [assignment('101', 'guest-1:starter')],
      }),
    )
    const text = JSON.stringify(dressed)
    expect(text).not.toContain('guest-1')
    expect(text).not.toContain(opaqueReferenceId('guest-1:starter'))
    expect(Object.keys(dressed!)).not.toContain('referenceId')
  })

  it('serves PokeAPI sprite URLs only, with a still PNG for the badge', () => {
    const dressed = resolve(
      snapshot({
        collection: [entry('r1', 'pikachu-family')],
        assignments: [assignment('101', 'r1')],
      }),
    )
    expect(dressed!.spriteUrl.startsWith('https://raw.githubusercontent.com/PokeAPI/sprites/')).toBe(true)
    expect(dressed!.stillUrl).toMatch(/^https:\/\/raw\.githubusercontent\.com\/PokeAPI\/sprites\/.*\.png$/)
  })

  it('tolerates a snapshot without assignments or companions (older clients)', () => {
    expect(
      resolveDressedCompanion({ collection: [] } as unknown as DressedSnapshot, '101', PROTOTYPE_COMPANION_CATALOG),
    ).toBeNull()
  })
})
