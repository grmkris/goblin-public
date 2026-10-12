import { describe, expect, it } from 'vitest'
import { STATUS } from '../api/fixtures.ts'
import {
  aboutSeconds,
  amountProblem,
  depositPhase,
  groupAddress,
  isSettled,
  needsNoDeposit,
  ownerOnBase,
} from './deposit-model.ts'

describe('an address to read', () => {
  it('groups the hex after 0x in fours and leaves anything else alone', () => {
    expect(groupAddress('0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17')).toBe(
      '0x4f1B 7c0a 2D9e 3b86 A5c1 E7f0 9d4B 2a6C 8e3F 5a17',
    )
    expect(groupAddress('0xabcdef')).toBe('0xabcd ef')
    expect(groupAddress('not an address')).toBe('not an address')
  })
})

describe('the amount to send', () => {
  it("takes a plain positive amount within the asset's decimals", () => {
    expect(amountProblem('0.01', 'ETH')).toBeUndefined()
    expect(amountProblem('25', 'USDC')).toBeUndefined()
    expect(amountProblem('0.000000000000000001', 'ETH')).toBeUndefined()
  })
  it('refuses zero, signs, exponents and excess precision', () => {
    expect(amountProblem('', 'USDC')).toBe('Enter an amount like 0.01 or 25.')
    expect(amountProblem('0', 'USDC')).toBe('Enter an amount above zero.')
    expect(amountProblem('-1', 'USDC')).toBeDefined()
    expect(amountProblem('1e3', 'ETH')).toBeDefined()
    expect(amountProblem('1.0000001', 'USDC')).toBe('USDC has at most 6 decimals.')
  })
  it('needs no deposit address for the same asset already on Base', () => {
    expect(needsNoDeposit({ from: 'base', asset: 'USDC', receive: 'USDC' })).toBe(true)
    expect(needsNoDeposit({ from: 'base', asset: 'ETH', receive: 'USDC' })).toBe(false)
    expect(needsNoDeposit({ from: 'arbitrum', asset: 'USDC', receive: 'USDC' })).toBe(false)
  })
})

describe('where a deposit stands', () => {
  it('follows Relay while it answers', () => {
    expect(depositPhase({ relay: undefined, before: 0n, now: 0n })).toBe('waiting')
    expect(depositPhase({ relay: 'pending', before: 0n, now: 0n })).toBe('pending')
    expect(depositPhase({ relay: 'success', before: 0n, now: 0n })).toBe('arrived')
    expect(depositPhase({ relay: 'refunded', before: 0n, now: 0n })).toBe('refunded')
    expect(depositPhase({ relay: 'failed', before: 0n, now: 0n })).toBe('failed')
  })
  it('reads Relay not answering as unknown, not as failed', () => {
    const phase = depositPhase({ relay: 'unknown', before: 5n, now: 5n })
    expect(phase).toBe('unknown')
    expect(isSettled(phase)).toBe(false)
  })
  it('counts the balance on Base rising as arrival, whatever Relay says', () => {
    expect(depositPhase({ relay: 'unknown', before: 5n, now: 9n })).toBe('arrived')
    expect(depositPhase({ relay: 'waiting', before: 5n, now: 9n })).toBe('arrived')
    expect(depositPhase({ relay: 'waiting', before: undefined, now: 9n })).toBe('waiting')
  })
  it("reads the owner's balance on Base in base units, and nothing when it was not read", () => {
    expect(ownerOnBase(STATUS, 'USDC')).toBe(62_500_000n)
    expect(ownerOnBase(STATUS, 'ETH')).toBe(5_399_666_120_503_803n)
    expect(ownerOnBase({ ...STATUS, balances: [] }, 'ETH')).toBeUndefined()
  })
  it('says how long it takes in round words', () => {
    expect(aboutSeconds(20)).toBe('about 20 seconds')
    expect(aboutSeconds(240)).toBe('about 4 minutes')
  })
})
