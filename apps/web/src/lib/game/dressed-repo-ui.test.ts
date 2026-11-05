import { describe, expect, it } from 'vitest'
import {
  assignmentsInSync,
  DRESSED_ROW_SUFFIX,
  dressedRowState,
  repoEmptyState,
  type ServerDressing,
} from './dressed-repo-ui'
import { plural } from '../copy'

/** The row labels on `/repos` (docs-plan/PLAN-dressed-repo-qa-fixes.md, fixes 1, 4 and 5). */

const A = { repositoryId: '1', referenceId: 'a' }
const B = { repositoryId: '2', referenceId: 'b' }

describe('assignmentsInSync', () => {
  it('ignores order', () => {
    expect(assignmentsInSync([A, B], [B, A])).toBe(true)
  })

  it('notices a missing, extra or moved assignment', () => {
    expect(assignmentsInSync([A], [])).toBe(false)
    expect(assignmentsInSync([], [A])).toBe(false)
    expect(assignmentsInSync([A], [{ repositoryId: '1', referenceId: 'b' }])).toBe(false)
  })
})

describe('dressedRowState', () => {
  const ready = (server = [A]): ServerDressing => ({ status: 'ready', server })
  const row = (dressing: ServerDressing, extra: Partial<{ badgesOn: boolean; isPrivate: boolean }> = {}) =>
    dressedRowState({ badgesOn: true, isPrivate: false, assignment: A, dressing, ...extra })

  it('says nothing about GitHub with the setting off', () => {
    expect(row(ready(), { badgesOn: false })).toBe('local')
  })

  it('never claims a private repo is shown', () => {
    expect(row(ready(), { isPrivate: true })).toBe('private')
  })

  it('is shown only when the server holds this exact pair', () => {
    expect(row(ready([A]))).toBe('shown')
    expect(row(ready([B]))).toBe('not-on-github')
  })

  it('maps every server state to a row state', () => {
    expect(row({ status: 'unknown' })).toBe('checking')
    expect(row({ status: 'saving' })).toBe('saving')
    expect(row({ status: 'error' })).toBe('not-on-github')
    expect(row({ status: 'never-synced' })).toBe('needs-first-sync')
    expect(row({ status: 'other-profile' })).toBe('other-profile')
  })

  it('has wording for every state', () => {
    for (const state of ['local', 'checking', 'private', 'shown', 'saving', 'not-on-github', 'needs-first-sync', 'other-profile'] as const) {
      expect(typeof DRESSED_ROW_SUFFIX[state]).toBe('string')
    }
    expect(DRESSED_ROW_SUFFIX.local).toBe('')
  })
})

describe('repoEmptyState', () => {
  it('asks a signed-out visitor to sign in instead of pointing at a page they cannot use', () => {
    expect(repoEmptyState(false)).toBe('sign-in')
    expect(repoEmptyState(true)).toBe('pick-repos')
  })
})

describe('plural', () => {
  it('uses the singular for exactly one', () => {
    expect(plural(1, 'tap')).toBe('1 tap')
    expect(plural(0, 'tap')).toBe('0 taps')
    expect(plural(3, 'companion')).toBe('3 companions')
    expect(plural(2, 'entry', 'entries')).toBe('2 entries')
  })
})
