import { describe, expect, it } from 'vitest'
import {
  loadVerifiedEventProofs,
  saveVerifiedEventProofs,
  type BrowserProductStorage,
} from './product-browser-storage'

function storage(): BrowserProductStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

describe('browser GitHub receipt storage', () => {
  it('keeps only valid receipts for the current event set', () => {
    const value = storage()
    const eventId = 'event-12345678-abcdef12'

    saveVerifiedEventProofs(
      value,
      {
        [eventId]: 'receipt',
        'event-not-valid': 'discard-me',
        'event-12345678-deadbeef': 'discard-me-too',
      },
      [eventId],
      'github-42',
    )

    expect(loadVerifiedEventProofs(value, 'github-42')).toEqual({ [eventId]: 'receipt' })
    expect(loadVerifiedEventProofs(value, 'github-43')).toEqual({})
  })

  it('fails closed for malformed stored data', () => {
    const value = storage()
    value.setItem('terrarium:github-event-proofs:github-42', '{bad json')

    expect(loadVerifiedEventProofs(value, 'github-42')).toEqual({})
  })
})
