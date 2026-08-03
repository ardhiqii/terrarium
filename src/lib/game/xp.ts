/**
 * Turns `GardenStats` and `GithubStats` into an XP ledger. Every rate comes
 * from `XP_RATES` / `COMMIT_XP_DAILY_CAP` in `types.ts`; nothing here is a
 * raw inlined number.
 */

import { GardenStats, GithubStats, XpEntry, XP_RATES, COMMIT_XP_DAILY_CAP } from './types'

/**
 * XP earned purely from the garden's shape: what has been published, how
 * densely it is linked, and how far notes have matured.
 *
 * "Note published" fires for any published content item, note or project
 * alike; the contract has a single `note-published` source (no separate
 * project variant), so `noteCount + projectCount` is used as the count.
 *
 * `promoted-budding` / `promoted-evergreen` are derived from the current
 * maturity snapshot rather than a historical event log, since nothing in
 * this codebase records *when* a note changed maturity, only what it is
 * now. A note currently `evergreen` is treated as having passed through the
 * budding promotion on its way there, so it counts toward both `promoted-
 * budding` and `promoted-evergreen`. This is a cumulative-credit reading of
 * a snapshot, not a literal replay of history.
 */
export function computeGardenXp(stats: GardenStats): XpEntry[] {
  const notePublishedCount = stats.noteCount + stats.projectCount
  const wordHundreds = Math.floor(stats.totalWords / 100)
  const buddingCount =
    stats.maturityCounts.budding + stats.maturityCounts.evergreen
  const evergreenCount = stats.maturityCounts.evergreen

  const entries: XpEntry[] = [
    {
      source: 'note-published',
      label: 'Notes and projects published',
      count: notePublishedCount,
      rate: XP_RATES.notePublished,
      xp: notePublishedCount * XP_RATES.notePublished,
    },
    {
      source: 'words',
      label: 'Words written',
      count: wordHundreds,
      rate: XP_RATES.perHundredWords,
      xp: wordHundreds * XP_RATES.perHundredWords,
    },
    {
      source: 'wikilink',
      label: 'Resolved wikilinks',
      count: stats.resolvedWikilinks,
      rate: XP_RATES.resolvedWikilink,
      xp: stats.resolvedWikilinks * XP_RATES.resolvedWikilink,
    },
    {
      source: 'backlink',
      label: 'Backlinks received',
      count: stats.backlinksReceived,
      rate: XP_RATES.backlinkReceived,
      xp: stats.backlinksReceived * XP_RATES.backlinkReceived,
    },
    {
      source: 'tag',
      label: 'Tags introduced',
      count: stats.tagCount,
      rate: XP_RATES.newTag,
      xp: stats.tagCount * XP_RATES.newTag,
    },
    {
      source: 'promoted-budding',
      label: 'Notes promoted to budding',
      count: buddingCount,
      rate: XP_RATES.promotedToBudding,
      xp: buddingCount * XP_RATES.promotedToBudding,
    },
    {
      source: 'promoted-evergreen',
      label: 'Notes promoted to evergreen',
      count: evergreenCount,
      rate: XP_RATES.promotedToEvergreen,
      xp: evergreenCount * XP_RATES.promotedToEvergreen,
    },
  ]

  return entries
}

/**
 * XP earned from GitHub commit activity. The daily cap applies per day
 * before summing across days, so a single high-volume day cannot be
 * amortised into an unbounded total.
 *
 * `GithubStats` (frozen) does not distinguish which repo a commit landed
 * in, so there is no data source for the `commit-garden` rate yet; only
 * the general `commit` source is emitted. When a future track extends the
 * GitHub fetch with per-repo counts, a `commit-garden` entry can be added
 * here without changing this function's shape.
 */
export function computeCommitXp(github: GithubStats | null): XpEntry[] {
  if (!github) return []

  let otherCommits = 0
  let gardenCommits = 0
  let otherXp = 0
  let gardenXp = 0

  for (const [day, dayTotal] of Object.entries(github.commitsByDay)) {
    // Garden commits are a subset of the day's total and score at the higher
    // rate, so they are counted first and the remainder falls to the base rate.
    const garden = Math.min(github.gardenCommitsByDay[day] ?? 0, dayTotal)
    const other = dayTotal - garden

    gardenCommits += garden
    otherCommits += other

    // The cap applies to the day as a whole, not per rate, so a heavy day of
    // garden commits cannot be topped up by also committing elsewhere.
    const rawGardenXp = garden * XP_RATES.commitToGarden
    const rawOtherXp = other * XP_RATES.commit
    const capped = Math.min(rawGardenXp + rawOtherXp, COMMIT_XP_DAILY_CAP)

    if (rawGardenXp + rawOtherXp === 0) continue
    // Distribute the capped amount proportionally so the ledger lines sum to
    // exactly the awarded total.
    const gardenShare = Math.round((capped * rawGardenXp) / (rawGardenXp + rawOtherXp))
    gardenXp += gardenShare
    otherXp += capped - gardenShare
  }

  const entries: XpEntry[] = []

  if (gardenCommits > 0) {
    entries.push({
      source: 'commit-garden',
      label: 'Commits to this garden',
      count: gardenCommits,
      rate: XP_RATES.commitToGarden,
      xp: gardenXp,
    })
  }

  if (otherCommits > 0) {
    entries.push({
      source: 'commit',
      label: 'GitHub commits',
      count: otherCommits,
      rate: XP_RATES.commit,
      xp: otherXp,
    })
  }

  return entries
}
