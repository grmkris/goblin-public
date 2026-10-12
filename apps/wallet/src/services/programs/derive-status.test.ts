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
  enforcedBy: 'test',
  ...(period === 'hour' ? { periodEndsAt: '2026-10-12T11:00:00.000Z' } : {}),
})
const base: StatusInput = {
  balances: [usdc('base', '12.5', 'owner'), usdc('tempo', '2.5', 'agent')],
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

  test('an empty wallet is blocked for funding', () => {
    expect(deriveStatus({ ...base, balances: [usdc('base', '0', 'agent')] })).toMatchObject({
      funding: 'blocked',
      paid: 'blocked',
    })
  })
})
