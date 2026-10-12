import { DatabaseSync } from 'node:sqlite'
import type { Terms } from '@goblin/wallet/contract'
import { fromNodeSqlite } from './sql.ts'
import { LedgerStore } from './store.ts'

/** Test helpers: an in-memory ledger on a controllable clock. */
export const T0 = Date.parse('2026-10-12T10:00:00.000Z')
export const AGENT = '0x1111111111111111111111111111111111111111'
export const EXA = '0x2222222222222222222222222222222222222222'
export const STRANGER = '0x3333333333333333333333333333333333333333'

export function testStore(): { store: LedgerStore; clock: { now: number } } {
  const clock = { now: T0 }
  const store = new LedgerStore(fromNodeSqlite(new DatabaseSync(':memory:')), () => clock.now)
  return { store, clock }
}

export const termsFor = (amountUsd: string, overrides: Partial<Terms> = {}): Terms => ({
  kind: 'paid_fetch',
  chain: 'base',
  rail: 'x402',
  subject: 'exa.search',
  token: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  amount: amountUsd,
  amountUsd,
  recipient: EXA,
  request: { method: 'POST', url: 'https://api.exa.ai/search' },
  expiresAt: new Date(T0 + 6 * 24 * 3_600_000).toISOString(),
  ...overrides,
})

let counter = 0
export function open(store: LedgerStore, amountUsd: string, overrides: Partial<Terms> = {}) {
  counter += 1
  const id = `op-${String(counter).padStart(6, '0')}`
  const result = store.begin({
    id,
    argsHash: `args-${id}`,
    terms: termsFor(amountUsd, overrides),
    termsHash: `0x${String(counter).padStart(64, 'a')}`,
    client: 'test client',
  })
  if (result.kind !== 'created') throw new Error('expected a new operation')
  return result.operation
}
