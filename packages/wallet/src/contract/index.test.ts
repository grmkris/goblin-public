import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  CollectRequest,
  termsHash,
  DEFAULT_SERVICES,
  OperationId,
  PaidFetchInput,
  ServiceRule,
  SUBSCRIPTION_MAX_PERIODS,
  SubscriptionRequest,
  TOOLS,
  UsdAmount,
  WalletStatus,
} from './index.ts'

const decode = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown) => Schema.decodeUnknownExit(schema)(value)

describe('contract', () => {
  it('keeps goblin WalletStatus shape', () => {
    const status = {
      kind: 'wallet',
      paid: 'ready',
      funding: 'ready',
      tokens: [{ symbol: 'USDC', balance: '12.5', remaining: '18', spendable: '5' }],
      periodEndsAt: '2026-10-12T06:00:00Z',
      expiresAt: '2026-10-19T05:00:00Z',
    }
    expect(decode(WalletStatus, status)._tag).toBe('Success')
    expect(decode(WalletStatus, { ...status, kind: 'other' })._tag).toBe('Failure')
  })

  it('reads USD amounts only as plain decimals', () => {
    for (const ok of ['0', '0.007', '5', '20.5', '123456789.123456']) expect(decode(UsdAmount, ok)._tag).toBe('Success')
    for (const bad of ['', '-1', '1e3', '0.0000001', '01', '1.', '.5', ' 1'])
      expect(decode(UsdAmount, bad)._tag).toBe('Failure')
  })

  it('accepts a paid_fetch call and rejects a short operation id', () => {
    const call = { service: 'exa.search', args: { query: 'tempo' }, max_usd: '0.05', operation_id: 'op-20261012-0001' }
    expect(decode(PaidFetchInput, call)._tag).toBe('Success')
    expect(decode(OperationId, 'short')._tag).toBe('Failure')
  })

  it('ships valid default services and stable tool names', () => {
    for (const service of DEFAULT_SERVICES) expect(decode(ServiceRule, service)._tag).toBe('Success')
    expect(TOOLS.paidFetch).toBe('paid_fetch')
    expect(TOOLS.status).toBe('wallet_status')
  })
  it('hashes terms canonically, whatever the key order', async () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 'x'], c: null }, z: undefined })).toBe(
      '{"a":{"c":null,"d":[2,"x"]},"b":1}',
    )
    const terms = {
      kind: 'paid_fetch',
      chain: 'base',
      rail: 'x402',
      subject: 'exa.search',
      token: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
      amount: '0.007',
      amountUsd: '0.007',
      recipient: '0x6d6E695b09861467c7d462f5AAF31cF3540B9192',
      expiresAt: '2026-10-12T06:00:00Z',
    } as const
    const reordered = { ...terms, token: { decimals: 6, address: terms.token.address, symbol: 'USDC' } }
    expect(await termsHash(terms)).toBe(await termsHash(reordered))
    expect(await termsHash(terms)).toMatch(/^0x[0-9a-f]{64}$/u)
  })

  it('asks a subscription per billing: a day pass of one-day periods, or a month of up to 30 days, for months', () => {
    const request = {
      plan: 'pro',
      billing: 'day',
      amountUsd: '1.00',
      periodDays: 1,
      months: 12,
      reference: 'user_1',
      returnUrl: 'https://goblin.surf/subscribe/success',
    }
    expect(decode(SubscriptionRequest, request)._tag).toBe('Success')
    expect(decode(SubscriptionRequest, { ...request, billing: 'month', amountUsd: '15.00', periodDays: 30 })._tag).toBe(
      'Success',
    )
    for (const bad of [
      { billing: 'week' },
      { billing: undefined },
      { periodDays: 0 },
      { periodDays: 31 },
      { months: 0 },
      { months: 25 },
    ])
      expect(decode(SubscriptionRequest, { ...request, ...bad })._tag, JSON.stringify(bad)).toBe('Failure')
  })

  it('collects any day of a year-long day pass, from period 1', () => {
    expect(SUBSCRIPTION_MAX_PERIODS).toBe(730)
    for (const period of [1, 365, 730])
      expect(decode(CollectRequest, { period, operationId: 'pro:user_1:1' })._tag).toBe('Success')
    for (const period of [0, 731, 1.5])
      expect(decode(CollectRequest, { period, operationId: 'pro:user_1:1' })._tag).toBe('Failure')
  })
})
