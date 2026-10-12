import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { type FloatRunner, LedgerObject, ledgerClient, WalletLedger } from './durable.ts'
import { alarmHost, T0, termsFor } from './fixtures.ts'

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

/** A ledger Durable Object with an alarm, on a test clock, running `runFloat` when its alarm fires. */
const object = (runFloat?: FloatRunner) => {
  const host = alarmHost()
  const clock = { now: T0 }
  const ledger = new LedgerObject(host, () => clock.now, runFloat)
  return { host, clock, ledger, client: ledgerClient(ledger) }
}

describe('the float alarm', () => {
  test('a schedule sets the alarm; the earliest request wins and the largest need is kept', async () => {
    const { host, client } = object()
    await client.scheduleFloat({ delayMs: 30_000 })
    expect(host.alarm.at).toBe(T0 + 30_000)
    await client.scheduleFloat({ delayMs: 0, need: '0.02' })
    expect(host.alarm.at).toBe(T0)
    await client.scheduleFloat({ delayMs: 60_000, need: '4.5' })
    expect(host.alarm.at).toBe(T0)
    expect(await client.startFloatRun()).toEqual({ need: '4.5', paused: false })
  })

  test('a malformed schedule is refused and sets nothing', async () => {
    const { host, ledger } = object()
    const call = (args: unknown[]) =>
      ledger.fetch(
        new Request('https://x/call', { method: 'POST', body: JSON.stringify({ method: 'scheduleFloat', args }) }),
      )
    expect((await call([{ delayMs: -1 }])).status).toBe(400)
    expect((await call([{ delayMs: 0, need: '1e3' }])).status).toBe(400)
    expect((await call([])).status).toBe(400)
    expect(host.alarm.at).toBeNull()
  })

  test('the alarm runs the float over this ledger and asks again when the run failed', async () => {
    const seen: boolean[] = []
    const { host, clock, ledger } = object(async (local) => {
      seen.push((await local.floatState()).refilling)
      if (seen.length === 1) await local.scheduleFloat({ delayMs: 10 })
      return { retryInMs: 60_000 }
    })
    clock.now += 5
    await ledger.alarm()
    expect(seen).toEqual([false])
    expect(host.alarm.at).toBe(T0 + 15)
    host.alarm.at = null
    await ledger.alarm()
    expect(host.alarm.at).toBe(T0 + 5 + 60_000)
  })

  test('a run that throws is not retried, and a ledger without a runner does nothing', async () => {
    const broken = object(() => Promise.reject(new Error('defect')))
    await broken.ledger.alarm()
    expect(broken.host.alarm.at).toBeNull()
    const plain = object()
    await plain.ledger.alarm()
    expect(plain.host.alarm.at).toBeNull()
  })
})
