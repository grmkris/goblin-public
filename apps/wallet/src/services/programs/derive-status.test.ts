import { describe, expect, test } from 'vitest'
import type { ChainBalance, LimitView } from '@goblin/wallet/contract'
import { deriveStatus, type StatusInput } from './derive-status.ts'

const usdc = (chain: ChainBalance['chain'], balance: string, holder: ChainBalance['holder']): ChainBalance => ({
  chain,
  symbol: 'USDC',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
  balance,
  holder,
  address: '0x1111111111111111111111111111111111111111',
})
const limit = (
  period: LimitView['period'],
  limitUsd: string,
  remaining?: string,
  layer: LimitView['layer'] = 'ledger',
): LimitView => ({
  layer,
  period,
  limit: limitUsd,
  ...(remaining === undefined ? {} : { remaining }),
  ...(layer === 'onchain' ? { chain: 'base' as const } : {}),
  enforcedBy: 'test',
  ...(period === 'hour' ? { periodEndsAt: '2026-10-12T11:00:00.000Z' } : {}),
})
const base: StatusInput = {
  balances: [usdc('base', '12.5', 'owner'), usdc('tempo', '2.5', 'agent')],
  unread: [],
  limits: [
    limit('call', '5'),
    limit('hour', '20', '17.25'),
    limit('week', '50', '40'),
    limit('hour', '20', '3', 'onchain'),
  ],
  verified: true,
  hasAgent: true,
  revoked: false,
  grantExpiresAt: '2026-10-19T10:00:00.000Z',
  now: Date.parse('2026-10-12T10:00:00.000Z'),
}

describe('deriveStatus', () => {
  test('sums the balances and spends no more than the tightest layer', () => {
    expect(deriveStatus(base)).toEqual({
      kind: 'wallet',
      paid: 'ready',
      funding: 'ready',
      tokens: [{ symbol: 'USDC', balance: '15', remaining: '3', spendable: '3' }],
      periodEndsAt: '2026-10-12T11:00:00.000Z',
      expiresAt: '2026-10-19T10:00:00.000Z',
    })
  })

  test('is blocked when revoked, expired or without an agent, and not verified when the chains cannot be read', () => {
    expect(deriveStatus({ ...base, revoked: true }).paid).toBe('blocked')
    expect(deriveStatus({ ...base, now: Date.parse('2026-10-20T00:00:00.000Z') }).paid).toBe('blocked')
    expect(deriveStatus({ ...base, hasAgent: false }).paid).toBe('blocked')
    expect(deriveStatus({ ...base, balances: [], verified: false })).toMatchObject({
      funding: 'not_verified',
      paid: 'not_verified',
    })
  })

  test("counts the owner's funds as spendable only on a chain with an allowance", () => {
    const ledgerOnly = [limit('call', '5'), limit('hour', '20', '17.25')]
    const held = [usdc('ethereum', '10', 'owner'), usdc('base', '0.5', 'agent')]
    expect(deriveStatus({ ...base, balances: held, limits: ledgerOnly }).tokens).toEqual([
      { symbol: 'USDC', balance: '10.5', remaining: '5', spendable: '0.5' },
    ])
    expect(deriveStatus({ ...base, balances: [usdc('ethereum', '10', 'owner')], limits: ledgerOnly })).toMatchObject({
      funding: 'ready',
      paid: 'blocked',
      tokens: [{ spendable: '0' }],
    })
  })

  test('the order of the balances does not change the answer', () => {
    expect(deriveStatus({ ...base, balances: base.balances.toReversed() })).toEqual(deriveStatus(base))
  })

  test('a chain that could not be read turns a no into not verified, and a yes stands', () => {
    const empty = { ...base, balances: [usdc('base', '0', 'agent')], unread: ['arbitrum' as const] }
    expect(deriveStatus(empty)).toMatchObject({ funding: 'not_verified', paid: 'not_verified' })
    expect(deriveStatus({ ...base, unread: ['arbitrum'] })).toMatchObject({ funding: 'ready', paid: 'ready' })
    expect(deriveStatus({ ...empty, revoked: true }).paid).toBe('blocked')
  })

  test('an empty wallet is blocked for funding', () => {
    expect(deriveStatus({ ...base, balances: [usdc('base', '0', 'agent')] })).toMatchObject({
      funding: 'blocked',
      paid: 'blocked',
    })
  })
})
