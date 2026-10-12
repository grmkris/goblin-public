import type { Me } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { STATUS } from '../api/fixtures.ts'
import { fundedOnBase, isSetUp, setupProgress } from './progress.ts'

const owner = '0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17'
const allowance = { perHour: '20', expiresAt: '2026-10-19T00:00:00Z', delegationHash: '0xab' }
const waiting = { funded: undefined }

describe('setupProgress', () => {
  it('walks the steps in order from server state', () => {
    const fresh: Me = { userId: 'u', owner, chains: [] }
    expect(setupProgress(fresh, waiting)).toBe('agent')
    const withAgent: Me = { ...fresh, agent: owner }
    expect(setupProgress(withAgent, waiting)).toBe('fund')
    expect(setupProgress(withAgent, { funded: false })).toBe('fund')
    expect(setupProgress(withAgent, { funded: true })).toBe('upgrade')
    const upgraded: Me = { ...withAgent, chains: [{ chain: 'base', upgraded: true }] }
    expect(setupProgress(upgraded, waiting)).toBe('allowance')
    const allowed: Me = { ...withAgent, chains: [{ chain: 'base', upgraded: true, allowance }] }
    expect(setupProgress(allowed, { funded: false })).toBe('done')
  })
})

describe('isSetUp', () => {
  it('needs the agent wallet, the upgrade and the allowance on Base, and no connection', () => {
    const allowed: Me = { userId: 'u', owner, agent: owner, chains: [{ chain: 'base', upgraded: true, allowance }] }
    expect(isSetUp(allowed)).toBe(true)
    expect(isSetUp({ ...allowed, agent: undefined })).toBe(false)
    expect(isSetUp({ ...allowed, chains: [{ chain: 'base', upgraded: true }] })).toBe(false)
    expect(isSetUp({ ...allowed, chains: [{ chain: 'arbitrum', upgraded: true, allowance }] })).toBe(false)
  })
})

const ownerOnBaseZero = (row: (typeof STATUS.balances)[number]) =>
  row.chain === 'base' && row.holder === 'owner' ? { ...row, balance: '0' } : row
const keepOwner = (symbol: string) => (row: (typeof STATUS.balances)[number]) =>
  row.chain === 'base' && row.holder === 'owner' && row.symbol !== symbol ? { ...row, balance: '0' } : row
/** The fixture status with the owner's USDC on Base at `balance`. */
const owning = (balance: string) => ({
  ...STATUS,
  balances: STATUS.balances.map((row) =>
    row.chain === 'base' && row.holder === 'owner' && row.symbol === 'USDC' ? { ...row, balance } : row,
  ),
})

describe('fundedOnBase', () => {
  it('counts USDC in the owner account on Base, not ETH: the upgrade pays its gas in USDC', () => {
    expect(fundedOnBase(STATUS)).toBe(true)
    expect(fundedOnBase({ ...STATUS, balances: STATUS.balances.map(keepOwner('USDC')) })).toBe(true)
    expect(fundedOnBase({ ...STATUS, balances: STATUS.balances.map(keepOwner('ETH')) })).toBe(false)
  })
  it('needs enough for the upgrade gas at its most, not just any USDC', () => {
    expect(fundedOnBase(owning('0.05'))).toBe(false)
    expect(fundedOnBase(owning('0.099999'))).toBe(false)
    expect(fundedOnBase(owning('0.1'))).toBe(true)
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
