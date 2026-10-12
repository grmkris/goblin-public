import * as Effect from 'effect/Effect'
import { describe, expect, test } from 'vitest'
import { runWallet } from '../runtime.ts'
import { Approvals } from './approvals.ts'
import { Ledger } from './ledger.ts'
import { walletLayer } from './index.ts'
import { Signer } from './signer.ts'
import type { RailsPort } from './rails.ts'
import { DatabaseSync } from 'node:sqlite'
import { ledgerClient, WalletLedger } from '../ledger/durable.ts'

const rails: RailsPort = {
  quotePaidFetch: () => Promise.reject(new Error('unused')),
  payPaidFetch: () => Promise.reject(new Error('unused')),
  payChallenge: () => Promise.reject(new Error('unused')),
  confirmChallenge: () => Promise.reject(new Error('unused')),
  quoteTransfer: () => Promise.reject(new Error('unused')),
  transfer: () => Promise.reject(new Error('unused')),
  swapQuote: () => Promise.reject(new Error('unused')),
  swapExecute: () => Promise.reject(new Error('unused')),
  bridgeQuote: () => Promise.reject(new Error('unused')),
  bridgeExecute: () => Promise.reject(new Error('unused')),
  balances: () => Promise.resolve({ balances: [], unread: [] }),
  allowances: () => Promise.resolve([]),
  check: () => Promise.reject(new Error('unused')),
  upgrade: () => Promise.reject(new Error('unused')),
}

const ledger = () => {
  const db = new DatabaseSync(':memory:')
  return ledgerClient(
    new WalletLedger({
      storage: {
        sql: { exec: (query, ...bindings) => ({ toArray: () => db.prepare(query).all(...bindings) }) },
        transactionSync: (write) => write(),
      },
    }),
  )
}

describe('the services and the runtime door', () => {
  test('a program reaches the ledger, the signer and the approval URL', async () => {
    const layer = walletLayer({ ledger: ledger(), signer: undefined, rails, origin: 'https://wallet.test' })
    const program = Effect.gen(function* () {
      const limits = yield* (yield* Ledger).use((api) => api.limits())
      const url = (yield* Approvals).urlFor('op-12345678')
      const agent = yield* (yield* Signer).address
      return { perHour: limits.perHour, url, agent }
    })
    expect(await runWallet(program, layer)).toEqual({
      ok: true,
      value: { perHour: '20', url: 'https://wallet.test/approve/op-12345678', agent: undefined },
    })
  })

  test('a missing signer is a typed 409, not a crash', async () => {
    const layer = walletLayer({ ledger: ledger(), signer: undefined, rails, origin: 'https://wallet.test' })
    const result = await runWallet(
      Effect.gen(function* () {
        return yield* (yield* Signer).require
      }),
      layer,
    )
    expect(result).toMatchObject({ ok: false, failure: { code: 'not_onboarded', status: 409 } })
  })

  test('an unreachable ledger is a typed 503', async () => {
    const broken = ledgerClient({ fetch: () => Promise.reject(new Error('down')) })
    const layer = walletLayer({ ledger: broken, signer: undefined, rails, origin: 'https://wallet.test' })
    const result = await runWallet(
      Effect.gen(function* () {
        return yield* (yield* Ledger).use((api) => api.limits())
      }),
      layer,
    )
    expect(result).toMatchObject({ ok: false, failure: { code: 'ledger_unavailable', status: 503 } })
  })
})
