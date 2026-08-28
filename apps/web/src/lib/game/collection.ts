/**
 * Assembles the repo creature COLLECTION for the site owner: one
 * `CreatureState` per repo, each species-assigned via `species-assign.ts`,
 * built from the exact same `composeCreatureState` pipeline every other repo
 * creature uses (`repo-creature.ts`). This is what `/companions` and
 * `/api/creatures` render.
 *
 * GARDEN-ASYMMETRY RULE STILL APPLIES: every entry here is built with
 * `emptyGardenStats()` and `isOwner: false`, exactly like `api/creature`'s
 * `buildRepoResponse`. A repo creature never gets the owner's local garden
 * stats or garden items, regardless of whose collection it appears in.
 *
 * Never throws. A repo whose fetch fails is silently skipped rather than
 * failing the whole collection; a broken GitHub call for one repo must not
 * blank the entire companions page.
 */
import { fetchOwnerRepos, type RepoSummary } from './repos'
import { fetchGithubStats } from './github'
import { toRepoCommitStats, composeCreatureState, emptyGardenStats } from './repo-creature'
import { assignSpeciesLine } from './species-assign'
import { diskCachePathFor } from './creature-route-shared'
import { detectClusters, type Cluster } from './clusters'
import type { CreatureState } from './types'
import type { SpeciesLine } from './sprites/species'

export interface CollectionEntry {
  /** Repo name for a `kind: 'repo'` entry, tag name for a `kind: 'cluster'`
   * entry. Kept as one field (rather than a union of shapes) so existing
   * rendering code that only reads `repo`/`language`/`speciesLine`/`state`
   * keeps working untouched. */
  repo: string
  language: string | null
  speciesLine: SpeciesLine
  state: CreatureState
  /**
   * 'repo' for a GitHub-derived creature, 'cluster' for a companion hatched
   * from a tag cluster of notes (see `clusters.ts`). Optional and defaults
   * to meaning "repo" when absent, so this stays backward compatible with
   * every entry built before clusters existed.
   */
  kind?: 'repo' | 'cluster'
  /** Only meaningful for `kind: 'cluster'`. See `clusters.ts` for how "new"
   * is derived without any persistence layer. */
  isNew?: boolean
}

export interface CollectionOptions {
  login: string
  token?: string
  /** Repo-list cache path override, test-only. */
  repoListCachePath?: string
  /** How many repo fetches run at once. Default 5. */
  concurrency?: number
}

/** Bounded-concurrency map, so a 24-repo collection fires a handful of GitHub calls at a time. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i])
    }
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, worker)
  await Promise.all(workers)
  return results
}

async function buildEntry(
  login: string,
  token: string | undefined,
  repo: RepoSummary
): Promise<CollectionEntry | null> {
  try {
    const fetched = await fetchGithubStats({
      login,
      gardenRepo: repo.name,
      token,
      cachePath: diskCachePathFor(login, repo.name),
    })
    if (!fetched) return null

    const repoGithub = toRepoCommitStats(fetched, repo.name)
    const state = composeCreatureState(emptyGardenStats(), repoGithub, {
      includeItems: false,
      isOwner: false,
    })
    const speciesLine = assignSpeciesLine({
      owner: login,
      repo: repo.name,
      language: repo.language,
      createdAt: repo.createdAt,
      pushedAt: repo.pushedAt,
      sizeKb: repo.sizeKb,
    })

    return { repo: repo.name, language: repo.language, speciesLine, state, kind: 'repo' }
  } catch {
    return null
  }
}

function clusterToEntry(cluster: Cluster): CollectionEntry {
  return {
    repo: cluster.tag,
    language: null,
    speciesLine: cluster.speciesLine,
    state: cluster.state,
    kind: 'cluster',
    isNew: cluster.isNew,
  }
}

/**
 * Companions hatched from note clusters (see `clusters.ts`). Notes-only,
 * synchronous, no network call, so unlike `getOwnerCollection` this never
 * needs options and cannot fail: a missing GitHub token or an outage has no
 * bearing on whether a tag cluster exists in local content.
 */
export function getClusterCollection(): CollectionEntry[] {
  return detectClusters().map(clusterToEntry)
}

/**
 * Never throws. Returns `[]` when the repo list itself cannot be fetched
 * (no login configured, network unavailable, no cache) so the collection
 * section can render an honest empty state instead of taking the page down.
 */
export async function getOwnerCollection(
  options: CollectionOptions
): Promise<CollectionEntry[]> {
  if (!options.login) return []

  const repos = await fetchOwnerRepos({
    login: options.login,
    token: options.token,
    cachePath: options.repoListCachePath,
  })
  if (!repos || repos.length === 0) return []

  const concurrency = options.concurrency ?? 5
  const entries = await mapWithConcurrency(repos, concurrency, (repo) =>
    buildEntry(options.login, options.token, repo)
  )

  return entries.filter((e): e is CollectionEntry => e !== null)
}
