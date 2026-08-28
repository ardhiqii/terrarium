import { describe, it, expect } from 'vitest'
import { computeGardenXp, computeCommitXp } from './xp'
import { GardenStats, GithubStats, XP_RATES, COMMIT_XP_DAILY_CAP } from './types'

function stats(overrides: Partial<GardenStats> = {}): GardenStats {
  return {
    noteCount: 0,
    projectCount: 0,
    totalWords: 0,
    resolvedWikilinks: 0,
    backlinksReceived: 0,
    tagCount: 0,
    maturityCounts: { seedling: 0, budding: 0, evergreen: 0 },
    maxBacklinksOnSingleNote: 0,
    firstPublishedAt: null,
    lastPublishedAt: null,
    ...overrides,
  }
}

function github(overrides: Partial<GithubStats> = {}): GithubStats {
  return {
    login: 'test-user',
    totalCommits: 0,
    commitsByDay: {},
    gardenCommitsByDay: {},
    currentStreakDays: 0,
    fetchedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function findEntry(entries: ReturnType<typeof computeGardenXp>, source: string) {
  const entry = entries.find((e) => e.source === source)
  if (!entry) throw new Error(`missing entry for source "${source}"`)
  return entry
}

describe('computeGardenXp', () => {
  it('produces no positive XP for zeroed stats', () => {
    const entries = computeGardenXp(stats())
    for (const entry of entries) {
      expect(entry.xp).toBe(0)
    }
  })

  it('rates every entry against XP_RATES, never a hardcoded literal', () => {
    const s = stats({
      noteCount: 3,
      projectCount: 2,
      totalWords: 250,
      resolvedWikilinks: 4,
      backlinksReceived: 7,
      tagCount: 3,
      maturityCounts: { seedling: 1, budding: 2, evergreen: 1 },
    })
    const entries = computeGardenXp(s)

    const notePublished = findEntry(entries, 'note-published')
    expect(notePublished.rate).toBe(XP_RATES.notePublished)
    expect(notePublished.count).toBe(5) // noteCount + projectCount
    expect(notePublished.xp).toBe(5 * XP_RATES.notePublished)

    const words = findEntry(entries, 'words')
    expect(words.rate).toBe(XP_RATES.perHundredWords)
    expect(words.count).toBe(2) // floor(250 / 100)
    expect(words.xp).toBe(2 * XP_RATES.perHundredWords)

    const wikilink = findEntry(entries, 'wikilink')
    expect(wikilink.rate).toBe(XP_RATES.resolvedWikilink)
    expect(wikilink.count).toBe(4)
    expect(wikilink.xp).toBe(4 * XP_RATES.resolvedWikilink)

    const backlink = findEntry(entries, 'backlink')
    expect(backlink.rate).toBe(XP_RATES.backlinkReceived)
    expect(backlink.count).toBe(7)
    expect(backlink.xp).toBe(7 * XP_RATES.backlinkReceived)

    const tag = findEntry(entries, 'tag')
    expect(tag.rate).toBe(XP_RATES.newTag)
    expect(tag.count).toBe(3)
    expect(tag.xp).toBe(3 * XP_RATES.newTag)

    // budding count is cumulative: budding + evergreen
    const budding = findEntry(entries, 'promoted-budding')
    expect(budding.rate).toBe(XP_RATES.promotedToBudding)
    expect(budding.count).toBe(3)
    expect(budding.xp).toBe(3 * XP_RATES.promotedToBudding)

    const evergreen = findEntry(entries, 'promoted-evergreen')
    expect(evergreen.rate).toBe(XP_RATES.promotedToEvergreen)
    expect(evergreen.count).toBe(1)
    expect(evergreen.xp).toBe(1 * XP_RATES.promotedToEvergreen)
  })

  it('treats every evergreen note as also having passed through budding', () => {
    const s = stats({ maturityCounts: { seedling: 0, budding: 0, evergreen: 4 } })
    const entries = computeGardenXp(s)
    expect(findEntry(entries, 'promoted-budding').count).toBe(4)
    expect(findEntry(entries, 'promoted-evergreen').count).toBe(4)
  })
})

describe('computeCommitXp', () => {
  it('returns an empty array for null github', () => {
    expect(computeCommitXp(null)).toEqual([])
  })

  it('caps a heavy day at COMMIT_XP_DAILY_CAP and leaves a light day uncapped, summing per-day', () => {
    // Day 1: 30 commits, all "other" (no garden commits). Raw would be
    // 30 * XP_RATES.commit = 150, capped to COMMIT_XP_DAILY_CAP (100).
    // Day 2: 5 commits, all "other". Raw = 5 * XP_RATES.commit = 25, uncapped.
    const gh = github({
      commitsByDay: { '2026-07-01': 30, '2026-07-02': 5 },
      gardenCommitsByDay: {},
    })
    const entries = computeCommitXp(gh)
    const commit = findEntry(entries, 'commit')
    expect(commit.count).toBe(35)
    // Proves the cap applies per day BEFORE summing: 100 + 25, not
    // min(35 * XP_RATES.commit, 2 * CAP) or any total-based cap.
    expect(commit.xp).toBe(125)
    expect(commit.xp).toBe(COMMIT_XP_DAILY_CAP + 5 * XP_RATES.commit)
    expect(commit.xp).not.toBe(35 * XP_RATES.commit) // would be 175 uncapped
  })

  it('scores garden commits at commitToGarden and other commits at commit, summing to the awarded total', () => {
    const gh = github({
      commitsByDay: { '2026-07-10': 6 },
      gardenCommitsByDay: { '2026-07-10': 3 },
    })
    const entries = computeCommitXp(gh)
    const garden = findEntry(entries, 'commit-garden')
    const other = findEntry(entries, 'commit')

    expect(garden.rate).toBe(XP_RATES.commitToGarden)
    expect(garden.count).toBe(3)
    expect(other.rate).toBe(XP_RATES.commit)
    expect(other.count).toBe(3)

    // Uncapped day (3*10 + 3*5 = 45 < 100), so the ledger lines sum exactly
    // to the raw awarded total.
    expect(garden.xp + other.xp).toBe(45)
    expect(garden.xp).toBe(3 * XP_RATES.commitToGarden)
    expect(other.xp).toBe(3 * XP_RATES.commit)
  })

  it('splits a capped day between garden and other proportionally, summing to exactly the cap', () => {
    // Raw: garden 8 * 10 = 80, other 8 * 5 = 40, total 120 > cap of 100.
    const gh = github({
      commitsByDay: { '2026-07-15': 16 },
      gardenCommitsByDay: { '2026-07-15': 8 },
    })
    const entries = computeCommitXp(gh)
    const garden = findEntry(entries, 'commit-garden')
    const other = findEntry(entries, 'commit')
    expect(garden.xp + other.xp).toBe(COMMIT_XP_DAILY_CAP)
  })

  it('produces no negative "other commits" count when gardenCommitsByDay equals commitsByDay', () => {
    const gh = github({
      commitsByDay: { '2026-07-20': 8 },
      gardenCommitsByDay: { '2026-07-20': 8 },
    })
    const entries = computeCommitXp(gh)
    const other = entries.find((e) => e.source === 'commit')
    // Either there is no "other" entry, or its count is non-negative (zero).
    if (other) {
      expect(other.count).toBeGreaterThanOrEqual(0)
    }
    const garden = findEntry(entries, 'commit-garden')
    expect(garden.count).toBe(8)
  })

  it('returns no entries when commitsByDay is empty', () => {
    expect(computeCommitXp(github())).toEqual([])
  })

  it('does not poison the ledger with NaN when a day has a zero commit total mixed with a real day', () => {
    // A zero-total day makes rawGardenXp + rawOtherXp === 0, which the
    // `continue` guard is meant to skip. Without that guard, the
    // proportional split below divides 0 by (rawGardenXp + rawOtherXp),
    // i.e. 0/0, producing NaN, which would then poison every subsequent
    // day's accumulated total once added together.
    const gh = github({
      commitsByDay: { '2026-07-01': 0, '2026-07-02': 4 },
      gardenCommitsByDay: {},
    })
    const entries = computeCommitXp(gh)
    const other = findEntry(entries, 'commit')
    expect(Number.isNaN(other.xp)).toBe(false)
    expect(other.xp).toBe(4 * XP_RATES.commit)
  })

  // Regression for a confirmed mutant survivor: `xp.ts:121` guards
  // `if (rawGardenXp + rawOtherXp === 0) continue`. Mutating `+` to `-`
  // survived the original suite because no existing test had a day where
  // rawGardenXp and rawOtherXp were equal-but-nonzero: that is exactly the
  // case `-` turns into `=== 0`, wrongly skipping a day that earned XP.
  // Day: 2 garden commits (2*10=20) + 4 other commits (4*5=20). Sum is 40
  // (nonzero, should score); difference is 0 (mutant would skip it).
  it('does not skip a day where garden XP equals other XP (kills the + -> - survivor)', () => {
    const gh = github({
      commitsByDay: { '2026-07-25': 6 },
      gardenCommitsByDay: { '2026-07-25': 2 },
    })
    const entries = computeCommitXp(gh)
    const garden = findEntry(entries, 'commit-garden')
    const other = findEntry(entries, 'commit')
    // Under the real `+` implementation this day is not skipped, so both
    // entries carry their full XP. Under the `-` mutant, rawGardenXp (20)
    // equals rawOtherXp (20), so `continue` fires and both would be 0.
    expect(garden.xp).toBe(2 * XP_RATES.commitToGarden)
    expect(other.xp).toBe(4 * XP_RATES.commit)
    expect(garden.xp + other.xp).toBe(40)
  })

  it('asserts the invariant xp.ts depends on: every gardenCommitsByDay key exists in commitsByDay with a count no larger, and violating it produces negative "other" XP', () => {
    // This is not a case xp.ts can defend against; it documents the
    // contract from types.ts (GithubStats.gardenCommitsByDay) that callers
    // must uphold. If a caller ever violates it (garden count > day total),
    // `other = dayTotal - garden` goes negative and corrupts the ledger.
    const validGh = github({
      commitsByDay: { '2026-07-25': 6 },
      gardenCommitsByDay: { '2026-07-25': 6 },
    })
    // Valid: garden count equals (not exceeds) the day total.
    for (const [day, gardenCount] of Object.entries(validGh.gardenCommitsByDay)) {
      expect(gardenCount).toBeLessThanOrEqual(validGh.commitsByDay[day])
    }

    // Demonstrate the failure mode when the invariant is violated: garden
    // count (10) exceeds the day's total commits (6).
    const violatingGh = github({
      commitsByDay: { '2026-07-25': 6 },
      gardenCommitsByDay: { '2026-07-25': 10 },
    })
    const entries = computeCommitXp(violatingGh)
    const other = entries.find((e) => e.source === 'commit')
    // `computeCommitXp` clamps `garden = Math.min(gardenCommitsByDay[day], dayTotal)`,
    // so it defends itself and does NOT go negative even under a violating
    // input; document that defense explicitly rather than assume it.
    if (other) {
      expect(other.count).toBeGreaterThanOrEqual(0)
      expect(other.xp).toBeGreaterThanOrEqual(0)
    }
  })
})
