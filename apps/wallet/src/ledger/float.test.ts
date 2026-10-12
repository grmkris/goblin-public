import type { Terms } from '@goblin/wallet/contract'
import { describe, expect, test } from 'vitest'
import { FLOAT_LEASE_MS } from './float.ts'
import { open, T0, testStore } from './fixtures.ts'

const AGENT = '0x4444444444444444444444444444444444444444'

const floatTerms = (amount = '2'): Terms => ({
  kind: 'bridge',
  chain: 'base',
  rail: 'relay',
  subject: `Moved $${amount}.00 to Tempo for paid inference`,
  token: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  amount,
  amountUsd: amount,
  recipient: AGENT,
  expiresAt: new Date(T0 + 600_000).toISOString(),
})

const claim = (store: ReturnType<typeof testStore>['store'], amount = '2') =>
  store.claimFloat({ terms: floatTerms(amount), termsHash: `0x${'f1'.repeat(32)}` })

describe('the Tempo float in the ledger', () => {
  test('one refill flies at a time: a second claim gets the one in flight', () => {
    const { store } = testStore()
    const first = claim(store)
    expect(first).toMatchObject({ kind: 'claimed', operation: { status: 'signing' } })
    if (first.kind === 'refused') throw new Error('expected a claim')
    expect(first.operation.id).toMatch(/^float:\d+:1$/u)
    expect(claim(store, '3')).toEqual({ kind: 'in_flight', operation: first.operation })
    expect(store.floatState()).toMatchObject({ refilling: true, operation: { id: first.operation.id } })
  })

  test('a refill shows in the activity but is never counted against the spend limits', () => {
    const { store } = testStore()
    const first = claim(store, '4')
    if (first.kind === 'refused') throw new Error('expected a claim')
    store.settle(first.operation.id, {
      payment: { rail: 'relay', userOpHash: `0x${'ab'.repeat(32)}` },
      delivered: true,
    })
    expect(store.activity(5)[0]).toMatchObject({
      id: first.operation.id,
      status: 'delivered',
      terms: { kind: 'bridge', rail: 'relay', subject: 'Moved $4.00 to Tempo for paid inference' },
    })
    expect(store.limitViews().filter((view) => view.period !== 'call' && view.period !== 'total')).toEqual([
      expect.objectContaining({ period: 'hour', used: '0' }),
      expect.objectContaining({ period: 'week', used: '0' }),
    ])
    const spend = open(store, '5')
    expect(store.reserve(spend.id).kind).toBe('reserved')
  })

  test('a finished refill frees the flight; so does a delivery Relay reported failed', () => {
    const { store } = testStore()
    const first = claim(store)
    if (first.kind === 'refused') throw new Error('expected a claim')
    store.fail(first.operation.id, 'Relay refused the quote.')
    expect(store.floatState().refilling).toBe(false)
    const second = claim(store)
    if (second.kind !== 'claimed') throw new Error('expected a new claim')
    store.settle(second.operation.id, {
      payment: { rail: 'relay' },
      delivery: { status: 'failed', detail: 'Relay: refunded' },
      delivered: false,
    })
    expect(store.operation(second.operation.id)?.status).toBe('confirmed')
    expect(claim(store).kind).toBe('claimed')
  })

  test('a deposit whose arrival is pending holds the flight until its lease ends; a lost run turns unknown', () => {
    const { store, clock } = testStore()
    const pending = claim(store)
    if (pending.kind === 'refused') throw new Error('expected a claim')
    store.settle(pending.operation.id, {
      payment: { rail: 'relay' },
      delivery: { status: 'pending', detail: 'Relay: waiting' },
      delivered: false,
    })
    expect(claim(store).kind).toBe('in_flight')
    clock.now += FLOAT_LEASE_MS + 1
    const lost = claim(store)
    if (lost.kind !== 'claimed') throw new Error('expected a new claim')
    clock.now += FLOAT_LEASE_MS + 1
    expect(claim(store).kind).toBe('claimed')
    expect(store.operation(lost.operation.id)).toMatchObject({
      status: 'uncertain',
      reason: 'The refill did not finish; its outcome is unknown.',
    })
  })

  test('a revoked wallet or an expired grant refills nothing', () => {
    const { store, clock } = testStore()
    store.revoke()
    expect(claim(store)).toEqual({ kind: 'refused', reason: 'The owner revoked this wallet.' })
    const other = testStore()
    other.store.limits()
    other.clock.now += 8 * 24 * 3_600_000
    expect(claim(other.store)).toEqual({ kind: 'refused', reason: 'The wallet grant expired.' })
    expect(clock.now).toBe(T0)
  })

  test('the largest noted need is taken by the next run, once', () => {
    const { store } = testStore()
    store.noteFloatNeed('0.02')
    store.noteFloatNeed('4.5')
    store.noteFloatNeed('0.5')
    expect(store.startFloatRun()).toEqual({ need: '4.5', paused: false })
    expect(store.startFloatRun()).toEqual({ paused: false })
  })

  test('failures retry twice, then refills pause for an hour; a refill that goes out clears them', () => {
    const { store, clock } = testStore()
    expect(store.endFloatRun('failed')).toEqual({ retryInMs: 60_000 })
    expect(store.endFloatRun('failed')).toEqual({ retryInMs: 300_000 })
    expect(store.endFloatRun('failed')).toEqual({})
    expect(store.startFloatRun().paused).toBe(true)
    expect(store.floatState().pausedUntil).toBe(new Date(T0 + 3_600_000).toISOString())
    clock.now += 3_600_001
    expect(store.startFloatRun().paused).toBe(false)
    expect(store.endFloatRun('failed')).toEqual({ retryInMs: 60_000 })
    expect(store.endFloatRun('sent')).toEqual({})
    expect(store.endFloatRun('failed')).toEqual({ retryInMs: 60_000 })
    expect(store.endFloatRun('idle')).toEqual({})
  })
})
