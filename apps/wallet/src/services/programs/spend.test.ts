import { DatabaseSync } from 'node:sqlite'
import type { Operation, Terms } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { describe, expect, test } from 'vitest'
import { unconfiguredRails } from '../../context.ts'
import { ledgerClient, LedgerObject } from '../../ledger/durable.ts'
import { runWallet } from '../../runtime.ts'
import { walletLayer } from '../index.ts'
import type { PayOutcome, RailsPort } from '../rails.ts'
import { paidFetchPlan, transferPlan } from './plans.ts'
import { runSpend } from './spend.ts'

const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const EXA = '0x2222222222222222222222222222222222222222'
const STRANGER = '0x3333333333333333333333333333333333333333'
const USDC = { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 } as const

const terms = (amountUsd: string, extra: Partial<Terms> = {}): Terms => ({
  kind: 'paid_fetch',
  chain: 'base',
  rail: 'x402',
  subject: 'exa.search',
  token: USDC,
  amount: amountUsd,
  amountUsd,
  recipient: EXA,
  request: { method: 'POST', url: 'https://api.exa.ai/search' },
  expiresAt: new Date(T0 + 3_600_000).toISOString(),
  ...extra,
})

interface Harness {
  clock: { now: number }
  paid: Operation[]
  next: { terms: Terms; outcome: PayOutcome | 'throw' }
  run: <A>(program: Parameters<typeof runWallet<A>>[0]) => ReturnType<typeof runWallet<A>>
  ledger: ReturnType<typeof ledgerClient>
}

function harness(): Harness {
  const clock = { now: T0 }
  const db = new DatabaseSync(':memory:')
  const ledger = ledgerClient(
    new LedgerObject(
      {
        storage: {
          sql: { exec: (query, ...bindings) => ({ toArray: () => db.prepare(query).all(...bindings) }) },
          transactionSync: (write) => write(),
        },
      },
      () => clock.now,
    ),
  )
  const paid: Operation[] = []
  const state: Harness['next'] = {
    terms: terms('0.007'),
    outcome: { outcome: 'settled', payment: { rail: 'x402', reference: 'ref-1' }, delivery: { status: 'ok' } },
  }
  const pay = (operation: Operation): Promise<PayOutcome> => {
    paid.push(operation)
    return state.outcome === 'throw' ? Promise.reject(new Error('socket hung up')) : Promise.resolve(state.outcome)
  }
  const rails: RailsPort = {
    ...unconfiguredRails,
    quotePaidFetch: () => Promise.resolve(state.terms),
    payPaidFetch: pay,
    quoteTransfer: () => Promise.resolve(state.terms),
    transfer: pay,
  }
  const layer = walletLayer({ ledger, signer: undefined, rails, origin: 'https://wallet.test' })
  return {
    clock,
    paid,
    ledger,
    get next() {
      return state
    },
    run: (program) => runWallet(program, layer),
  }
}

const fetchInput = (operation: string, maxUsd = '0.05') => ({
  service: 'exa.search',
  args: { query: 'goblin wallet' },
  max_usd: maxUsd,
  operation_id: operation,
})

const spendFetch = (input: ReturnType<typeof fetchInput>) =>
  Effect.gen(function* () {
    return yield* runSpend(yield* paidFetchPlan(input, 'Test client'))
  })

describe('the paid_fetch spend program', () => {
  test('pays once, records the receipt and replays without paying again', async () => {
    const h = harness()
    const first = await h.run(spendFetch(fetchInput('op-happy-0001')))
    expect(first).toMatchObject({
      ok: true,
      value: { kind: 'done', replay: false, operation: { status: 'delivered', payment: { reference: 'ref-1' } } },
    })
    const again = await h.run(spendFetch(fetchInput('op-happy-0001')))
    expect(again).toMatchObject({ ok: true, value: { kind: 'done', replay: true, operation: { status: 'delivered' } } })
    expect(h.paid).toHaveLength(1)
  })

  test('refuses a different request under the same operation_id', async () => {
    const h = harness()
    await h.run(spendFetch(fetchInput('op-conflict-1')))
    const result = await h.run(spendFetch(fetchInput('op-conflict-1', '0.04')))
    expect(result).toMatchObject({ ok: false, failure: { code: 'operation_id_reused', status: 409 } })
    expect(h.paid).toHaveLength(1)
  })

  test('spends nothing when the price is above max_usd or the service cap', async () => {
    const h = harness()
    h.next.terms = terms('0.02')
    expect(await h.run(spendFetch(fetchInput('op-cap-user-1', '0.01')))).toMatchObject({
      ok: false,
      failure: { code: 'above_max_usd' },
    })
    h.next.terms = terms('0.5')
    expect(await h.run(spendFetch(fetchInput('op-cap-svc-001', '1')))).toMatchObject({
      ok: false,
      failure: { code: 'above_service_cap' },
    })
    expect(h.paid).toHaveLength(0)
    expect(await h.ledger.activity(10)).toEqual([])
  })

  test('refuses a service the owner has not allowed', async () => {
    const h = harness()
    const result = await h.run(spendFetch({ ...fetchInput('op-unknown-svc'), service: 'evil.service' }))
    expect(result).toMatchObject({ ok: false, failure: { code: 'unknown_service', status: 404 } })
  })

  test('a failed rail releases the reservation; an unreachable one keeps it as uncertain and is never retried', async () => {
    const h = harness()
    h.next.outcome = { outcome: 'failed', reason: 'facilitator refused' }
    expect(await h.run(spendFetch(fetchInput('op-failed-001')))).toMatchObject({
      ok: true,
      value: { operation: { status: 'failed', reason: 'facilitator refused' } },
    })
    h.next.outcome = 'throw'
    const unsure = await h.run(spendFetch(fetchInput('op-unsure-001')))
    expect(unsure).toMatchObject({ ok: true, value: { operation: { status: 'uncertain' } } })
    const paidSoFar = h.paid.length
    await h.run(spendFetch(fetchInput('op-unsure-001')))
    expect(h.paid).toHaveLength(paidSoFar)
    const hour = (await h.ledger.limitViews()).find((limit) => limit.period === 'hour')
    expect(hour?.used).toBe('0.007')
  })

  test('a paid request whose delivery failed is confirmed, not delivered', async () => {
    const h = harness()
    h.next.outcome = {
      outcome: 'settled',
      payment: { rail: 'x402' },
      delivery: { status: 'failed', detail: 'HTTP 502' },
    }
    expect(await h.run(spendFetch(fetchInput('op-nodeliv-01')))).toMatchObject({
      value: { operation: { status: 'confirmed', delivery: { status: 'failed' } } },
    })
  })
})

describe('approvals in the spend program', () => {
  test('over the per-call limit to a known recipient waits with the limit it crosses', async () => {
    const h = harness()
    await h.ledger.addRecipient('base', STRANGER, 'friend')
    h.next.terms = terms('6', { kind: 'transfer', rail: 'transfer', recipient: STRANGER, subject: 'transfer' })
    const input = {
      chain: 'base',
      token: 'USDC',
      to: STRANGER,
      amount: '6',
      max_usd: '7',
      operation_id: 'op-over-00001',
    } as const
    const waiting = await h.run(
      Effect.gen(function* () {
        return yield* runSpend(yield* transferPlan(input, 'Test client'))
      }),
    )
    expect(waiting).toMatchObject({
      ok: true,
      value: {
        kind: 'awaiting_approval',
        approval: { reason: 'over_limit', crosses: [{ layer: 'ledger', period: 'call' }] },
      },
    })
    expect(h.paid).toHaveLength(0)
  })

  test('a transfer to a stranger waits for approval, does not pay, and pays once after approval', async () => {
    const h = harness()
    h.next.terms = terms('1', { kind: 'transfer', rail: 'transfer', recipient: STRANGER, subject: 'transfer' })
    const input = {
      chain: 'base',
      token: 'USDC',
      to: STRANGER,
      amount: '1',
      max_usd: '2',
      operation_id: 'op-xfer-00001',
    } as const
    const program = Effect.gen(function* () {
      return yield* runSpend(yield* transferPlan(input, 'Test client'))
    })
    const waiting = await h.run(program)
    expect(waiting).toMatchObject({
      ok: true,
      value: {
        kind: 'awaiting_approval',
        url: 'https://wallet.test/approve/op-xfer-00001',
        approval: { reason: 'new_recipient' },
      },
    })
    expect(h.paid).toHaveLength(0)
    expect(await h.run(program)).toMatchObject({ value: { kind: 'awaiting_approval' } })
    const approval = await h.ledger.approval('op-xfer-00001')
    await h.ledger.decide('op-xfer-00001', { decision: 'approve', termsHash: approval?.termsHash ?? '' })
    expect(await h.run(program)).toMatchObject({
      ok: true,
      value: { kind: 'done', operation: { status: 'delivered' } },
    })
    expect(await h.run(program)).toMatchObject({ value: { replay: true } })
    expect(h.paid).toHaveLength(1)
  })

  test('a declined approval ends the operation and nothing is paid', async () => {
    const h = harness()
    h.next.terms = terms('1', { kind: 'transfer', rail: 'transfer', recipient: STRANGER, subject: 'transfer' })
    const input = {
      chain: 'base',
      token: 'USDC',
      to: STRANGER,
      amount: '1',
      max_usd: '2',
      operation_id: 'op-decline-01',
    } as const
    const program = Effect.gen(function* () {
      return yield* runSpend(yield* transferPlan(input, 'Test client'))
    })
    await h.run(program)
    const approval = await h.ledger.approval('op-decline-01')
    await h.ledger.decide('op-decline-01', { decision: 'decline', termsHash: approval?.termsHash ?? '' })
    expect(await h.run(program)).toMatchObject({
      ok: true,
      value: { kind: 'done', replay: true, operation: { status: 'declined' } },
    })
    expect(h.paid).toHaveLength(0)
  })

  test('an approval left for half an hour expires with the operation', async () => {
    const h = harness()
    h.next.terms = terms('1', { kind: 'transfer', rail: 'transfer', recipient: STRANGER, subject: 'transfer' })
    const input = {
      chain: 'base',
      token: 'USDC',
      to: STRANGER,
      amount: '1',
      max_usd: '2',
      operation_id: 'op-expire-001',
    } as const
    const program = Effect.gen(function* () {
      return yield* runSpend(yield* transferPlan(input, 'Test client'))
    })
    await h.run(program)
    h.clock.now = T0 + 31 * 60_000
    expect(await h.run(program)).toMatchObject({ ok: false, failure: { code: 'approval_expired' } })
    expect(h.paid).toHaveLength(0)
  })

  test('a revoked wallet refuses a new spend', async () => {
    const h = harness()
    await h.ledger.revoke()
    expect(await h.run(spendFetch(fetchInput('op-revoked-001')))).toMatchObject({
      ok: false,
      failure: { code: 'revoked', status: 403 },
    })
    expect(h.paid).toHaveLength(0)
  })
})
