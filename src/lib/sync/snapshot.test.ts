import { describe, expect, it } from 'vitest'
import { buildSnapshot } from './snapshot'
import { SNAPSHOT_SCHEMA_VERSION } from './types'
import type { CreatureState, GardenStats, ItemDef, ItemState, Stage } from '../game/types'
import type { Cluster } from '../game/clusters-from-items'
import type { ContentMeta } from '../types'
import type { SpeciesLine } from '../game/sprites/species'

// Distinctive, made-up strings that would never appear in a numeric field or
// a stage id by accident. If any of these show up in the serialised
// snapshot, something is copying real garden content instead of the counts
// and enums `SyncedSnapshot` allows.
const SECRET_NOTE_TITLE = 'Zzyzx Midnight Confession About My Landlord'
const SECRET_TAG_NAME = 'quixotic-ferret-taxonomy'
const SECRET_REPO_NAME = 'wtf-nobody-should-see-this-repo'
const SECRET_SPECIES_NAME = 'Quixotic Ferret Companion'

function fakeStage(overrides: Partial<Stage> = {}): Stage {
  return {
    id: 'mossling',
    name: 'Mossling',
    index: 2,
    threshold: 1500,
    blurb: 'Notes are accumulating and starting to link.',
    ...overrides,
  }
}

function fakeStats(): GardenStats {
  return {
    noteCount: 12,
    projectCount: 3,
    totalWords: 4321,
    resolvedWikilinks: 7,
    backlinksReceived: 9,
    tagCount: 5,
    maturityCounts: { seedling: 4, budding: 5, evergreen: 3 },
    maxBacklinksOnSingleNote: 4,
    firstPublishedAt: '2024-01-01T00:00:00.000Z',
    lastPublishedAt: '2024-06-01T00:00:00.000Z',
  }
}

function fakeItemDef(id: string): ItemDef {
  return {
    id: id as ItemDef['id'],
    name: `Item ${id}`,
    requirement: 'Some requirement',
    sprite: id,
    unlocked: () => true,
    progress: () => 1,
  }
}

function fakeItemState(id: string, unlocked: boolean): ItemState {
  return { def: fakeItemDef(id), unlocked, progress: unlocked ? 1 : 0.3 }
}

function fakeCreatureState(): CreatureState {
  return {
    stage: fakeStage(),
    nextStage: fakeStage({ id: 'bracken', name: 'Bracken', index: 3, threshold: 5000 }),
    totalXp: 2200,
    xpIntoStage: 700,
    xpForNextStage: 3500,
    progress: 0.2,
    breakdown: [
      {
        source: 'note-published',
        label: `Notes and projects published (${SECRET_NOTE_TITLE})`,
        count: 12,
        rate: 100,
        xp: 1200,
      },
    ],
    items: [fakeItemState('spore-jar', true), fakeItemState('dew-vial', false)],
    stats: fakeStats(),
    github: {
      login: SECRET_REPO_NAME,
      totalCommits: 42,
      commitsByDay: { '2024-06-01': 3 },
      gardenCommitsByDay: {},
      currentStreakDays: 3,
      fetchedAt: '2024-06-01T00:00:00.000Z',
    },
    generatedAt: '2024-06-01T00:00:00.000Z',
  }
}

function fakeCluster(): Cluster {
  const member: ContentMeta = {
    title: SECRET_NOTE_TITLE,
    date: '2024-01-01',
    description: 'A description nobody should upload either',
    tags: [SECRET_TAG_NAME],
    type: 'note',
    slug: 'zzyzx-midnight-confession',
    collection: 'notes',
    href: '/notes/zzyzx-midnight-confession',
  }

  const speciesLine: SpeciesLine = {
    id: 'fake-species',
    name: SECRET_SPECIES_NAME,
    theme: 'A theme nobody should upload',
    languages: [],
  } as unknown as SpeciesLine

  return {
    tag: SECRET_TAG_NAME,
    members: [member],
    speciesLine,
    state: fakeCreatureState(),
    isNew: false,
  }
}

describe('buildSnapshot (privacy boundary)', () => {
  it('serialises to only numbers, enums, and counts: no tag names, note titles, or repo names', () => {
    const state = fakeCreatureState()
    const clusters = [fakeCluster()]

    const snapshot = buildSnapshot(state, clusters)
    const serialised = JSON.stringify(snapshot)

    expect(serialised).not.toContain(SECRET_NOTE_TITLE)
    expect(serialised).not.toContain(SECRET_TAG_NAME)
    expect(serialised).not.toContain(SECRET_REPO_NAME)
    expect(serialised).not.toContain(SECRET_SPECIES_NAME)
  })

  it('copies exactly the fields SyncedSnapshot names, nothing else', () => {
    const state = fakeCreatureState()
    const clusters = [fakeCluster()]

    const snapshot = buildSnapshot(state, clusters)

    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'schemaVersion',
        'totalXp',
        'stage',
        'stageIndex',
        'noteCount',
        'projectCount',
        'totalWords',
        'tagCount',
        'companions',
        'unlockedItemIds',
        'generatedAt',
      ].sort()
    )
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION)
    expect(snapshot.totalXp).toBe(2200)
    expect(snapshot.stage).toBe('mossling')
    expect(snapshot.stageIndex).toBe(2)
    expect(snapshot.noteCount).toBe(12)
    expect(snapshot.projectCount).toBe(3)
    expect(snapshot.totalWords).toBe(4321)
    expect(snapshot.tagCount).toBe(5)
    expect(snapshot.unlockedItemIds).toEqual(['spore-jar'])
    expect(snapshot.companions).toEqual([{ stage: 'mossling', stageIndex: 2 }])
    // Companion objects must have exactly stage + stageIndex, never a tag.
    expect(Object.keys(snapshot.companions[0]).sort()).toEqual(['stage', 'stageIndex'])
  })

  it('produces an empty companions array when there are no clusters', () => {
    const snapshot = buildSnapshot(fakeCreatureState(), [])
    expect(snapshot.companions).toEqual([])
  })
})
