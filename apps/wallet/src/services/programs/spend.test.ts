import { DatabaseSync } from 'node:sqlite'
import type { Operation, Terms } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { describe, expect, test } from 'vitest'
import { unconfiguredRails } from '../../context.ts'
import { ledgerClient, LedgerObject } from '../../ledger/durable.ts'
import { runWallet } from '../../runtime.ts'
import { walletLayer } from '../index.ts'
import type { PayOutcome, RailsPort } from '../rails.ts'
import { executeQuotePlan, freezeQuote, paidFetchPlan, transferPlan } from './plans.ts'
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

function harness(wrap: (ledger: Harness['ledger']) => Harness['ledger'] = (ledger) => ledger): Harness {
  const clock = { now: T0 }
  const db = new DatabaseSync(':memory:')
  const inner = ledgerClient(
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
  const ledger = wrap(inner)
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
    swapQuote: () =>
      Promise.resolve({
        quote: {
          quote_id: 'quote-swap-001',
          summary: 'swap 1 USDC',
          amountUsd: '1',
          expiresAt: new Date(T0 + 300_000).toISOString(),
        },
        terms: terms('1', { kind: 'swap', rail: 'lifi', recipient: EXA, subject: 'swap' }),
        payload: { route: 'a' },
      }),
    swapExecute: pay,
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

// SAFETY: the fake rail ignores its input; only the frozen answer matters.
const SWAP_INPUT = {} as Parameters<RailsPort['swapQuote']>[0]

/** A ledger whose lookup saw nothing: the loser of a begin race looked the id up before the winner began. */
const racing = (ledger: Harness['ledger']): Harness['ledger'] => ({
  ...ledger,
  lookup: () => Promise.resolve({ kind: 'none' }),
})

describe('operation identity under races (finding 1)', () => {
  test('a call that lost the begin race to other arguments is rejected, not handed the winner', async () => {
    const h = harness(racing)
    await h.ledger.begin({
      id: 'op-race-00001',
      argsHash: 'the-winners-args',
      terms: terms('0.001'),
      termsHash: '0xwinner',
      client: 'winner',
    })
    const result = await h.run(spendFetch(fetchInput('op-race-00001')))
    expect(result).toMatchObject({ ok: false, failure: { code: 'operation_id_reused', status: 409 } })
    expect(h.paid).toHaveLength(0)
  })

  test('a quote payload is never paid under another quote operation terms', async () => {
    const h = harness()
    await h.run(freezeQuote('swap', (port) => port.swapQuote(SWAP_INPUT)))
    const input = { quote_id: 'quote-swap-001', max_usd: '2', operation_id: 'op-bound-0001' }
    const plan = await h.run(executeQuotePlan('swap', input, 'Test client'))
    if (!plan.ok) throw new Error('no plan')
    // The id was already begun by the same args hash but with different frozen terms.
    await h.ledger.begin({
      id: 'op-bound-0001',
      argsHash: plan.value.argsHash,
      terms: terms('0.5', { kind: 'swap', rail: 'lifi', subject: 'swap' }),
      termsHash: '0xother',
      client: 'c',
    })
    const result = await h.run(runSpend(plan.value))
    expect(result).toMatchObject({ ok: false, failure: { code: 'operation_id_reused' } })
    expect(h.paid).toHaveLength(0)
  })
})

describe('signing re-checks authority (finding 8)', () => {
  const reservedFetch = async (h: Harness, id: string) => {
    const plan = await h.run(paidFetchPlan(fetchInput(id), 'Test client'))
    if (!plan.ok) throw new Error('no plan')
    const hash = `0x${'a'.repeat(64)}`
    await h.ledger.begin({ id, argsHash: plan.value.argsHash, terms: terms('0.007'), termsHash: hash, client: 'c' })
    await h.ledger.reserve(id)
    return plan.value
  }

  test('a reservation left unsigned past the grant expiry does not sign on retry', async () => {
    const h = harness()
    const plan = await reservedFetch(h, 'op-lapsed-0001')
    h.clock.now = T0 + 8 * 24 * 3_600_000
    const result = await h.run(runSpend(plan))
    expect(result).toMatchObject({ ok: false, failure: { code: 'grant_expired' } })
    expect(h.paid).toHaveLength(0)
    expect((await h.ledger.operation('op-lapsed-0001'))?.status).toBe('failed')
  })

  test('a stale reservation is re-admitted under the current window when it signs', async () => {
    const h = harness()
    const plan = await reservedFetch(h, 'op-stale-00001')
    h.clock.now = T0 + 50 * 60_000
    await h.ledger.setLimits({ perCall: '5', perHour: '20', perWeek: '50', expiresAt: '2026-11-30T00:00:00.000Z' })
    // terms expire after an hour in this harness; stay inside it but past most of the hour window
    const result = await h.run(runSpend(plan))
    expect(result).toMatchObject({ ok: true, value: { operation: { status: 'delivered' } } })
    h.clock.now = T0 + 70 * 60_000
    const hour = (await h.ledger.limitViews()).find((limit) => limit.period === 'hour')
    expect(hour?.used).toBe('0.007')
  })

  test('limits that shrank since reserving leave no room: the spend is refused and released', async () => {
    const h = harness()
    const plan = await reservedFetch(h, 'op-shrunk-0001')
    await h.ledger.setLimits({
      perCall: '0.001',
      perHour: '0.002',
      perWeek: '0.003',
      expiresAt: '2026-11-30T00:00:00.000Z',
    })
    const result = await h.run(runSpend(plan))
    expect(result).toMatchObject({ ok: false, failure: { code: 'over_limit' } })
    expect(h.paid).toHaveLength(0)
    expect((await h.ledger.limitViews()).find((limit) => limit.period === 'hour')?.used).toBe('0')
  })
})

describe('quote execution replays before it needs a live quote (finding 10)', () => {
  test('a lost reply after payment returns the existing outcome once the quote has expired', async () => {
    const h = harness()
    await h.run(freezeQuote('swap', (port) => port.swapQuote(SWAP_INPUT)))
    const input = { quote_id: 'quote-swap-001', max_usd: '2', operation_id: 'op-replay-0001' }
    const execute = Effect.gen(function* () {
      return yield* runSpend(yield* executeQuotePlan('swap', input, 'Test client'))
    })
    expect(await h.run(execute)).toMatchObject({ ok: true, value: { operation: { status: 'delivered' } } })
    h.clock.now = T0 + 10 * 60_000
    expect(await h.run(execute)).toMatchObject({
      ok: true,
      value: { replay: true, operation: { status: 'delivered' } },
    })
    expect(h.paid).toHaveLength(1)
    const fresh = { ...input, operation_id: 'op-replay-0002' }
    expect(
      await h.run(
        Effect.gen(function* () {
          return yield* runSpend(yield* executeQuotePlan('swap', fresh, 'Test client'))
        }),
      ),
    ).toMatchObject({ ok: false, failure: { code: 'quote_expired' } })
  })
})
