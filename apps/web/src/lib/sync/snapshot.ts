/**
 * Builds a `SyncedSnapshot` (see `./types.ts`, frozen) from a `CreatureState`
 * plus the cluster ("companion") list.
 *
 * THIS FUNCTION IS THE PRIVACY BOUNDARY IN CODE FORM. `CreatureState` and
 * `Cluster` carry real garden content -- note titles, tag names, repo names,
 * word bodies -- because they are used to render the owner's own creature
 * page. `SyncedSnapshot` must never carry any of that: only counts and
 * enums. So this function copies fields one at a time, by name, rather than
 * spreading or deriving generically, and it copies ONLY the fields
 * `SyncedSnapshot` names. That is deliberate and must stay that way: a
 * future change that wants to upload one more field has to edit this
 * function by hand and will see exactly what it is adding. See
 * `snapshot.test.ts` for the regression test that a future change cannot
 * quietly widen this to include tag names, note titles, or repo names.
 *
 * No `fs` import here (and none transitively): this file only touches pure
 * types from `../game/types` and `../game/clusters-from-items`, so it stays
 * safe to import from a client bundle if a future surface ever wants to
 * preview the snapshot before syncing.
 */

import { SNAPSHOT_SCHEMA_VERSION, type SyncedSnapshot } from './types'
import type { CreatureState } from '../game/types'
import type { Cluster } from '../game/clusters-from-items'

export function buildSnapshot(
  state: CreatureState,
  clusters: readonly Cluster[]
): SyncedSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    totalXp: state.totalXp,
    stage: state.stage.id,
    stageIndex: state.stage.index,
    noteCount: state.stats.noteCount,
    projectCount: state.stats.projectCount,
    totalWords: state.stats.totalWords,
    tagCount: state.stats.tagCount,
    // Stage only, per companion. No tag, no members, no title: a companion
    // in `Cluster` is keyed by tag and its members are real notes, neither
    // of which belongs in a synced snapshot.
    companions: clusters.map((cluster) => ({
      stage: cluster.state.stage.id,
      stageIndex: cluster.state.stage.index,
    })),
    // Item ids are fixed enum values from `ItemId` (types.ts), not user
    // content, so they are safe to upload as-is.
    unlockedItemIds: state.items.filter((item) => item.unlocked).map((item) => item.def.id),
    generatedAt: new Date().toISOString(),
  }
}
