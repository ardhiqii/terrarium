import { describe, expect, it } from 'vitest'
import {
  optIn,
  isProfilePublic,
  parseVisibility,
  isPublicField,
  DEFAULT_VISIBILITY,
  PUBLIC_PROFILE_FIELDS,
  NEVER_PUBLIC_FIELDS,
} from './profile-visibility'

describe('profile-visibility', () => {
  it('defaults every profile to private (opt-in, never opt-out)', () => {
    expect(DEFAULT_VISIBILITY).toBe('private')
    // Even a null/missing policy must not render publicly.
    expect(isProfilePublic(null)).toBe(false)
  })

  it('only a public policy renders a profile', () => {
    expect(isProfilePublic({ visibility: 'public', updatedAt: 't' })).toBe(true)
    expect(isProfilePublic({ visibility: 'private', updatedAt: 't' })).toBe(false)
  })

  it('optIn flips a profile on and lowercases the handle', () => {
    const record = optIn('OctoCat', '2026-09-12T00:00:00.000Z')
    expect(record.visibility).toBe('public')
    expect(record.handle).toBe('octocat')
  })

  it('parses only a literal public as public; anything else is private', () => {
    expect(parseVisibility('public')).toBe('public')
    expect(parseVisibility('private')).toBe('private')
    expect(parseVisibility(undefined)).toBe('private')
    expect(parseVisibility('visible')).toBe('private')
  })

  it('separates public aggregate fields from private ones', () => {
    expect(PUBLIC_PROFILE_FIELDS.length).toBeGreaterThan(0)
    expect(NEVER_PUBLIC_FIELDS.length).toBeGreaterThan(0)
    // No overlap: a field can never be both public and never-public.
    for (const field of PUBLIC_PROFILE_FIELDS) {
      expect(isPublicField(field)).toBe(true)
      expect(NEVER_PUBLIC_FIELDS).not.toContain(field)
    }
    expect(isPublicField('handle')).toBe(true)
    expect(isPublicField('guestId')).toBe(false)
    expect(isPublicField('totalWords')).toBe(false) // sensitive
  })
})
