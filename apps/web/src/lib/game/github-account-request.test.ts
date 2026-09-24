import { describe, expect, it } from 'vitest'
import {
  githubAccountHeaders,
  isAccountChangedBody,
  isAccountChangedError,
  TERRARIUM_GITHUB_ID_HEADER,
} from './github-account-request'

describe('account-bound GitHub requests', () => {
  it('captures the account ID without dropping content headers', () => {
    expect(githubAccountHeaders(9001, { 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      [TERRARIUM_GITHUB_ID_HEADER]: '9001',
    })
  })

  it('recognizes the explicit account-change response and stream error', () => {
    expect(isAccountChangedBody({ error: 'account_changed' })).toBe(true)
    expect(isAccountChangedBody({ code: 'account-changed' })).toBe(true)
    expect(isAccountChangedBody({ error: 'try again' })).toBe(false)
    expect(isAccountChangedError(new Error('account_changed'))).toBe(true)
  })
})
