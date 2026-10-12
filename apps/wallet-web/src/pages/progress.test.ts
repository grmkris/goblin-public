import type { Me } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { setupProgress } from './progress.ts'

const owner = '0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17'
const allowance = { perHour: '20', expiresAt: '2026-10-19T00:00:00Z', delegationHash: '0xab' }

describe('setupProgress', () => {
  it('walks the steps in order from server state', () => {
    const fresh: Me = { userId: 'u', owner, chains: [] }
    expect(setupProgress(fresh, false, false)).toBe('agent')
    const withAgent: Me = { ...fresh, agent: owner }
    expect(setupProgress(withAgent, false, false)).toBe('upgrade')
    expect(setupProgress({ ...withAgent, chains: [{ chain: 'base', upgraded: true }] }, false, false)).toBe('allowance')
    const allowed: Me = { ...withAgent, chains: [{ chain: 'base', upgraded: true, allowance }] }
    expect(setupProgress(allowed, false, false)).toBe('connect')
  })
  it('finishes when an agent is connected or the owner skipped', () => {
    const allowed: Me = { userId: 'u', owner, agent: owner, chains: [{ chain: 'base', upgraded: true, allowance }] }
    expect(setupProgress(allowed, true, false)).toBe('done')
    expect(setupProgress(allowed, false, true)).toBe('done')
  })
})
