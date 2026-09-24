import { describe, expect, it } from 'vitest'
import {
  beginAccountHydration,
  commitAccountHydration,
  createAccountNamespaceGate,
  hydratedAccountNamespace,
  invalidateAccountNamespace,
  isCurrentAccountNamespace,
} from './github-account-scope'

describe('GitHub account namespace gate', () => {
  it('does not let delayed hydration for an older account become writable', () => {
    let gate = createAccountNamespaceGate()
    const first = beginAccountHydration(gate, 101)
    gate = first.gate
    const second = beginAccountHydration(gate, 202)
    gate = second.gate

    const stale = commitAccountHydration(gate, first.token)
    expect(stale.scope).toBeNull()
    expect(stale.gate).toBe(gate)
    expect(hydratedAccountNamespace(gate)).toBeNull()

    const current = commitAccountHydration(gate, second.token)
    expect(current.scope).toEqual(second.token)
    expect(isCurrentAccountNamespace(current.gate, second.token)).toBe(true)
  })

  it('gates account writes until the immutable namespace is hydrated', () => {
    let gate = createAccountNamespaceGate()
    const pending = beginAccountHydration(gate, 42)
    gate = pending.gate
    expect(hydratedAccountNamespace(gate)).toBeNull()

    const committed = commitAccountHydration(gate, pending.token)
    expect(hydratedAccountNamespace(committed.gate)).toEqual(pending.token)
    expect(isCurrentAccountNamespace(committed.gate, pending.token)).toBe(true)

    const invalidated = invalidateAccountNamespace(committed.gate)
    expect(hydratedAccountNamespace(invalidated)).toBeNull()
    expect(isCurrentAccountNamespace(invalidated, pending.token)).toBe(false)
  })
})
