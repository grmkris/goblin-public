import { describe, expect, it } from 'vitest'
import { signInStatus } from './auth.tsx'

const address = '0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17'

describe('signInStatus', () => {
  it('waits while Privy loads or the owner wallet is being created', () => {
    expect(signInStatus({ ready: false, authenticated: false, address: undefined, stalled: false })).toBe('loading')
    expect(signInStatus({ ready: true, authenticated: true, address: undefined, stalled: false })).toBe('loading')
  })

  it('stops waiting once the wait has stalled, so the page can offer a way out', () => {
    expect(signInStatus({ ready: false, authenticated: false, address: undefined, stalled: true })).toBe('stalled')
    expect(signInStatus({ ready: true, authenticated: true, address: undefined, stalled: true })).toBe('stalled')
  })

  it('is ready with an owner wallet and signed out without a session, whatever the timer says', () => {
    expect(signInStatus({ ready: true, authenticated: true, address, stalled: true })).toBe('ready')
    expect(signInStatus({ ready: true, authenticated: false, address: undefined, stalled: true })).toBe('signed-out')
  })
})
