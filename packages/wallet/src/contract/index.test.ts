import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SERVICES, OperationId, PaidFetchInput, ServiceRule, TOOLS, UsdAmount, WalletStatus } from './index.ts'

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
})
