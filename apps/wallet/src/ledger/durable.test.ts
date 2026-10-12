import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { ledgerClient, WalletLedger } from './durable.ts'
import { termsFor } from './fixtures.ts'

function newLedger(): WalletLedger {
  const db = new DatabaseSync(':memory:')
  return new WalletLedger({
    storage: {
      sql: {
        exec: (query, ...bindings) => ({ toArray: () => db.prepare(query).all(...bindings) }),
      },
      transactionSync: (write) => write(),
    },
  })
}

describe('WalletLedger Durable Object', () => {
  test('answers the store methods over fetch', async () => {
    const client = ledgerClient(newLedger())
    expect((await client.limits()).perHour).toBe('20')
    const begun = await client.begin({
      id: 'op-do-0001',
      argsHash: 'a',
      terms: termsFor('1'),
      termsHash: '0xab',
      client: 'c',
    })
    expect(begun.kind).toBe('created')
    expect((await client.reserve('op-do-0001')).kind).toBe('reserved')
    expect(await client.operation('missing-op')).toBeUndefined()
  })

  test('refuses unknown methods and other routes', async () => {
    const ledger = newLedger()
    const call = (body: unknown, path = '/call', method = 'POST') =>
      ledger.fetch(
        new Request(`https://x${path}`, method === 'POST' ? { method, body: JSON.stringify(body) } : { method }),
      )
    expect((await call({ method: 'constructor', args: [] })).status).toBe(404)
    expect((await call({ method: 'toString', args: [] })).status).toBe(404)
    expect((await call({ nope: 1 })).status).toBe(400)
    expect((await call({}, '/other')).status).toBe(404)
    expect((await call({}, '/call', 'GET')).status).toBe(404)
  })
})
