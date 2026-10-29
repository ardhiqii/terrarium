/**
 * The reveal card must describe the draw the way the storage does.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT: the card shipped a sentence that was true
 * before eggs existed and false after. Nothing failed when it went stale — the copy
 * and the data are separate nodes, the build stayed green, and the only signal was a
 * user who could not find the companion he had just been told he owned. The same
 * shape as the missing sign-in button: the UI lied, and the compiler had no opinion.
 *
 * What shipped and was wrong, verbatim:
 *   "New companion added to your collection"  for a draw sitting in `eggs`
 *   plus a "Make active" button, which `switchActiveCompanion` refuses for a
 *   companion that is not in the collection, so the button silently did nothing.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  revealKindFor,
  revealLabel,
  revealOffersMakeActive,
} from './encounter-reveal'
import {
  namespaceFromProfileKey,
  profileKeyFor,
  profileKeyFromNamespace,
} from '../sync/viewer-profile-key'

const WEB = path.join(__dirname, '..', '..', '..')

function read(relative: string): string {
  return readFileSync(path.join(WEB, relative), 'utf8')
}

/**
 * The full argument text of every `name(...)` call, balanced across newlines.
 *
 * A line-based grep is not enough for these calls: the object literal spans a dozen
 * lines and the namespace argument sits on the last one, so a per-line check passed
 * while the wrong value was still being passed. That failure mode is the whole reason
 * this helper exists.
 */
function callBlocks(source: string, name: string): string[] {
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf(name + '(', from)
    if (start < 0) break
    let depth = 0
    let i = start + name.length
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    blocks.push(source.slice(start, i + 1))
    from = i + 1
  }
  return blocks
}

const CARD = 'src/components/game/EncounterReveal.tsx'

describe('revealKindFor', () => {
  it('calls a draw that is still an egg an egg, even though it is not a duplicate', () => {
    // The exact state a new signed-in user lands in: starter in the collection, the
    // daily draw waiting as an egg, and the draw is not a duplicate.
    const kind = revealKindFor({ id: 'daily:2026-10-08', isDuplicate: false }, new Set(['daily:2026-10-08']))
    expect(kind).toBe('egg')
  })

  it('calls a duplicate a duplicate', () => {
    expect(revealKindFor({ id: 'x', isDuplicate: true }, new Set())).toBe('duplicate')
  })

  it('calls a hatched draw a collection entry', () => {
    // Once the egg is opened its draw id stays in `encounters.draws` but leaves the
    // egg inventory, so the same draw must now report itself as claimed.
    expect(revealKindFor({ id: 'x', isDuplicate: false }, new Set())).toBe('collection')
  })

  it('prefers egg over duplicate when a profile somehow has both', () => {
    // `layEggs` never lays an egg for a duplicate, so this cannot happen through the
    // app. A hand-edited or restored profile could still produce it, and the copy
    // must describe what the user can see in the inventory.
    const kind = revealKindFor({ id: 'x', isDuplicate: true }, new Set(['x']))
    expect(kind).toBe('egg')
  })
})

describe('revealLabel', () => {
  it('points an egg at the screen that can open it, never at the collection', () => {
    const label = revealLabel('egg', { essenceAwarded: 0 })
    expect(label).not.toContain('added to your collection')
    expect(label.toLowerCase()).toContain('egg')
    expect(label.toLowerCase()).toContain('companions')
  })

  it('keeps the essence wording for a duplicate', () => {
    expect(revealLabel('duplicate', { essenceAwarded: 7 })).toContain('+7 Essence')
  })

  it('only claims a collection entry for a hatched draw', () => {
    expect(revealLabel('collection', { essenceAwarded: 0 })).toContain('added to your collection')
  })
})

describe('revealOffersMakeActive', () => {
  it('does not offer an action the switcher will refuse', () => {
    // switchActiveCompanion returns the state unchanged when the companion is not in
    // the collection. Offering the button for an egg is a control that cannot work.
    expect(revealOffersMakeActive('egg')).toBe(false)
    expect(revealOffersMakeActive('duplicate')).toBe(false)
    expect(revealOffersMakeActive('collection')).toBe(true)
  })
})

describe('the card is wired to the verdicts rather than to `isDuplicate`', () => {
  it('does not decide its own copy from the duplicate flag', () => {
    const source = read(CARD)
    // The exact expression that shipped and lied. If the card goes back to branching
    // on `isDuplicate` alone it will announce eggs as owned companions again.
    expect(source).not.toContain('draw.isDuplicate\n')
    expect(source).not.toMatch(/draw\.isDuplicate\s*\?/)
    expect(source).toContain('revealKindFor')
    expect(source).toContain('revealLabel')
    expect(source).toContain('revealOffersMakeActive')
  })

  it('reads the egg inventory so it knows which draws are unopened', () => {
    expect(read(CARD)).toContain('eggDrawIds')
  })
})

describe('GuestCompanionOnboarding resolves the viewer key like every other surface', () => {
  const source = read('src/components/game/GuestCompanionOnboarding.tsx')

  it('never reads or writes the bare signed-out key', () => {
    // The last component that did. On a signed-in browser it read nothing, created a
    // fresh starter, and wrote it under the signed-out key: a second profile no other
    // surface reads, so the panel showed a companion the rest of the app knew nothing
    // about. `tsc` does not catch this because `key` has a default.
    expect(source).toContain('useViewerProfileKey')
    // Per line rather than per regex: a call site can contain a nested call
    // (`saveGuestProfile(browserStorage(), profile, key)`), so "everything up to the
    // first `)`" is not the argument list.
    const callLines = source
      .split('\n')
      .filter((line) => /(load|save)GuestProfile\(/.test(line))
    expect(callLines.length).toBeGreaterThan(0)
    for (const line of callLines) {
      expect(line, `every profile call must name profileKey: ${line.trim()}`).toContain('profileKey')
    }
  })

  it('names profileKey in every dependency array that guards on it', () => {
    // The `[]` trap that killed the daily draw: the effect runs once before the key
    // exists, returns, and never runs again.
    expect(source).not.toMatch(/\}, \[\]\)/)
    expect(source).toContain('[profileKey]')
  })
})

describe('useViewerProfileKey never leaves a caller waiting forever', () => {
  const source = read('src/lib/sync/use-viewer-profile-key.ts')

  it('falls back to the signed-out key once the session request has settled', () => {
    // A settled request with no session (signed out, or the endpoint unreachable)
    // must still produce a key. Returning null in that case makes every guarded
    // caller render a spinner instead of the profile the user already has.
    expect(source).toContain('session ? session.profileKey : GUEST_PROFILE_STORAGE_KEY')
  })
})

describe('the sibling state keys are namespaced by the id, not by the profile key', () => {
  const hook = read('src/lib/sync/use-viewer-profile-key.ts')
  const keys = read('src/lib/sync/viewer-profile-key.ts')

  it('derives the namespace instead of passing the whole profile key', () => {
    // WHAT I GOT WRONG FIRST: I passed `profileKey` straight through as the namespace,
    // and `product-browser-storage` appends the namespace itself, so the state landed at
    // `terrarium:guest-encounters:terrarium:guest-profile:github-123`. Nothing reads that
    // key, so the import looked like it had done nothing while silently leaving the
    // account's real encounter state empty, which hands out a second daily draw.
    expect(hook).toContain('namespaceFromProfileKey(profileKey)')
    // Check per CALL, not per line: `saveBrowserEncounters({...}, profileKey)` spans
    // several lines, so a line-based check passed while the argument was still wrong.
    // That is exactly how the first fix shipped incomplete.
    for (const call of ['loadBrowserEncounters', 'saveBrowserEncounters', 'loadRevealedDraws',
                        'saveRevealedDraws', 'loadBrowserLedger', 'saveBrowserLedger']) {
      for (const block of callBlocks(hook, call)) {
        expect(block, `${call} must take the namespace, not the profile key`)
          .not.toMatch(/\bprofileKey\b/)
      }
    }
  })

  it('keeps one definition of the derivation, beside the function it inverts', () => {
    // Two copies of this derivation is how the hook and the component would drift.
    const definitions = keys.split('export function namespaceFromProfileKey').length - 1
    expect(definitions).toBe(1)
    expect(read('src/components/game/GuestProductRuntime.tsx')).not.toContain(
      'function namespaceFromProfileKey',
    )
  })

  it('is the exact inverse of profileKeyFor', () => {
    // The two have to agree, so check the round trip rather than trusting a comment.
    expect(namespaceFromProfileKey(profileKeyFor(929255477))).toBe('github-929255477')
    expect(namespaceFromProfileKey(profileKeyFor(null))).toBeUndefined()
    expect(profileKeyFromNamespace(namespaceFromProfileKey(profileKeyFor(42)))).toBe(
      profileKeyFor(42),
    )
  })
})

describe('the guest import carries the encounter state, not just the profile', () => {
  const source = read('src/lib/sync/use-viewer-profile-key.ts')

  it('moves the claimed days, the meter, and the revealed list with the profile', () => {
    // THE BUG: the profile holds the collection and the eggs, but NOT which days have
    // been claimed. That is the encounter state, under its own namespaced key. Moving
    // only the profile left the account reading an empty encounter state, and an empty
    // encounter state says today is unclaimed, so signing in handed the user a SECOND
    // daily draw for the same day. The reveal card then came back too, because the
    // dismissal list had reset with it.
    expect(source).toContain('migrateEncounterStateIntoAccount')
    expect(source).toContain('loadBrowserEncounters')
    expect(source).toContain('saveBrowserEncounters')
    expect(source).toContain('processedTriggerIds')
    expect(source).toContain('loadRevealedDraws')
    expect(source).toContain('saveRevealedDraws')
  })

  it('unions the claimed days instead of picking one side', () => {
    // Overwriting with either side loses something real: the guest's days alone forget
    // days the account already claimed, and the account's alone is the bug.
    expect(source).toContain('...accountEncounters.processedTriggerIds')
    expect(source).toContain('...guestEncounters.processedTriggerIds')
  })

  it('keeps the furthest-along meter rather than resetting to zero', () => {
    expect(source).toContain('Math.max(accountEncounters.meter, guestEncounters.meter)')
  })

  it('runs even when the profiles share an identity', () => {
    // `planGuestMigration` returns null for the same guest id, which is the normal case
    // for a browser that has only ever used one identity. Returning early there would
    // skip the encounter move exactly when it is most likely to be needed.
    const sameIdentity = source.slice(source.indexOf('const plan = planGuestMigration'))
    const moveAt = sameIdentity.indexOf('migrateEncounterStateIntoAccount')
    // Matched as a WORD: a prose mention of "returning" in a comment is not the branch.
    const returnAt = sameIdentity.search(/\breturn\b/u)
    expect(moveAt).toBeGreaterThan(-1)
    expect(returnAt).toBeGreaterThan(-1)
    expect(moveAt).toBeLessThan(returnAt)
  })
})
