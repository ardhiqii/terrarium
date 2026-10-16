import { describe, it, expect, vi } from 'vitest'
import { detectWikilinkTrigger, runGardenMutation } from './EditorPane'

describe('runGardenMutation', () => {
  it('notifies exactly once after the complete mutation succeeds', async () => {
    const calls: string[] = []

    await runGardenMutation(
      async () => {
        calls.push('mutation')
      },
      async () => {
        calls.push('scan')
      }
    )

    expect(calls).toEqual(['mutation', 'scan'])
  })

  it('passes rename proof only after the rename succeeds', async () => {
    const onMutation = vi.fn()
    const hint = { from: 'old.md', to: 'new.md' }

    await runGardenMutation(async () => undefined, onMutation, hint)

    expect(onMutation).toHaveBeenCalledOnce()
    expect(onMutation).toHaveBeenCalledWith(hint)
  })

  it('does not notify when the mutation fails', async () => {
    const onMutation = vi.fn()

    await expect(
      runGardenMutation(async () => {
        throw new Error('write failed')
      }, onMutation)
    ).rejects.toThrow('write failed')

    expect(onMutation).not.toHaveBeenCalled()
  })
})

describe('detectWikilinkTrigger', () => {
  it('detects an open, unclosed [[ before the caret', () => {
    const text = 'See [[Too'
    const trigger = detectWikilinkTrigger(text, text.length)
    expect(trigger).toEqual({ start: 4, query: 'Too' })
  })

  it('returns null once the link has been closed', () => {
    const text = 'See [[Tools]] already linked'
    expect(detectWikilinkTrigger(text, text.length)).toBeNull()
  })

  it('returns null when there is no [[ at all', () => {
    expect(detectWikilinkTrigger('plain text', 5)).toBeNull()
  })

  it('returns null across a newline, so a stray [[ on an earlier line does not leak', () => {
    const text = '[[Unclosed\nNext line'
    expect(detectWikilinkTrigger(text, text.length)).toBeNull()
  })

  it('tracks the most recently opened [[ when two appear', () => {
    const text = '[[First]] and [[Sec'
    expect(detectWikilinkTrigger(text, text.length)).toEqual({ start: 14, query: 'Sec' })
  })
})
