import type { Me } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { STATUS } from '../api/fixtures.ts'
import { fundedOnBase, setupProgress } from './progress.ts'

const owner = '0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17'
const allowance = { perHour: '20', expiresAt: '2026-10-19T00:00:00Z', delegationHash: '0xab' }
const waiting = { connected: false, skipped: false, funded: undefined }

describe('setupProgress', () => {
  it('walks the steps in order from server state', () => {
    const fresh: Me = { userId: 'u', owner, chains: [] }
    expect(setupProgress(fresh, waiting)).toBe('agent')
    const withAgent: Me = { ...fresh, agent: owner }
    expect(setupProgress(withAgent, waiting)).toBe('fund')
    expect(setupProgress(withAgent, { ...waiting, funded: false })).toBe('fund')
    expect(setupProgress(withAgent, { ...waiting, funded: true })).toBe('upgrade')
    const upgraded: Me = { ...withAgent, chains: [{ chain: 'base', upgraded: true }] }
    expect(setupProgress(upgraded, waiting)).toBe('allowance')
    const allowed: Me = { ...withAgent, chains: [{ chain: 'base', upgraded: true, allowance }] }
    expect(setupProgress(allowed, waiting)).toBe('connect')
  })
  it('finishes when an agent is connected or the owner skipped, whatever the balance', () => {
    const allowed: Me = { userId: 'u', owner, agent: owner, chains: [{ chain: 'base', upgraded: true, allowance }] }
    expect(setupProgress(allowed, { ...waiting, connected: true })).toBe('done')
    expect(setupProgress(allowed, { ...waiting, skipped: true, funded: false })).toBe('done')
  })
})

const ownerOnBaseZero = (row: (typeof STATUS.balances)[number]) =>
  row.chain === 'base' && row.holder === 'owner' ? { ...row, balance: '0' } : row
const keepOwner = (symbol: string) => (row: (typeof STATUS.balances)[number]) =>
  row.chain === 'base' && row.holder === 'owner' && row.symbol !== symbol ? { ...row, balance: '0' } : row

describe('fundedOnBase', () => {
  it('counts USDC or ETH in the owner account on Base', () => {
    expect(fundedOnBase(STATUS)).toBe(true)
    expect(fundedOnBase({ ...STATUS, balances: STATUS.balances.map(keepOwner('USDC')) })).toBe(true)
    expect(fundedOnBase({ ...STATUS, balances: STATUS.balances.map(keepOwner('ETH')) })).toBe(true)
  })
  it('ignores the agent wallet and other networks', () => {
    const elsewhere = STATUS.balances.map((row) => ownerOnBaseZero({ ...row, balance: '50' }))
    expect(fundedOnBase({ ...STATUS, balances: elsewhere })).toBe(false)
  })
  it('says nothing until Base is read', () => {
    expect(fundedOnBase({ ...STATUS, balances: [] })).toBeUndefined()
    expect(fundedOnBase(undefined)).toBeUndefined()
  })
})
