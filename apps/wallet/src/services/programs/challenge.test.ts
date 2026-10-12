import { DatabaseSync } from 'node:sqlite'
import type { Operation, PayChallengeInput } from '@goblin/wallet/contract'
import type { ReceiptFinding } from '@goblin/wallet/tempo'
import { describe, expect, test } from 'vitest'
import { unconfiguredRails } from '../../context.ts'
import { ledgerClient, WalletLedger } from '../../ledger/durable.ts'
import { runWallet } from '../../runtime.ts'
import { walletLayer } from '../index.ts'
import type { PayOutcome, RailsPort } from '../rails.ts'
import { payChallenge, reportChallengeReceipt } from './challenge.ts'

const OPENROUTER = '0xca4e835F803cB0b7C428222B3A3B98518d4779Fe'
const USDC_E = '0x20c000000000000000000000b9537d11c60e8b50'
const PATH_USD = '0x20c0000000000000000000000000000000000000'
const URL_OK = 'https://openrouter.mpp.tempo.xyz/v1/chat/completions'

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

const entry = (
  id: string,
  fields: { amount?: string; recipient?: string; currency?: string; expires?: string } = {},
) => {
  const request = {
    amount: fields.amount ?? '750',
    currency: fields.currency ?? USDC_E,
    methodDetails: { chainId: 4217, feePayer: true },
    recipient: fields.recipient ?? OPENROUTER,
  }
  const expires = fields.expires ?? new Date(Date.now() + 240_000).toISOString()
  return `Payment id="${id}", realm="openrouter.mpp.tempo.xyz", method="tempo", intent="charge", request="${b64url(request)}", expires="${expires}"`
}

/** OpenRouter's shape: the USDC.e and pathUSD charges side by side. */
const header = (id: string, fields: Parameters<typeof entry>[1] = {}) =>
  `${entry(id, fields)}, ${entry(`${id}-path`, { ...fields, currency: PATH_USD })}`

const input = (operationId: string, challenge: string, extra: Partial<PayChallengeInput> = {}): PayChallengeInput => ({
  operation_id: operationId,
  url: URL_OK,
  method: 'POST',
  challenge,
  max_usd: '0.02',
  ...extra,
})

function harness() {
  const db = new DatabaseSync(':memory:')
  const ledger = ledgerClient(
    new WalletLedger({
      storage: {
        sql: { exec: (query, ...bindings) => ({ toArray: () => db.prepare(query).all(...bindings) }) },
        transactionSync: (write) => write(),
      },
    }),
  )
  const signed: { operation: Operation; challengeId: string }[] = []
  const state: { pay: PayOutcome | undefined; finding: ReceiptFinding } = {
    pay: undefined,
    finding: { kind: 'paid', payment: { rail: 'mpp', txHash: `0x${'ab'.repeat(32)}` } },
  }
  const rails: RailsPort = {
    ...unconfiguredRails,
    allowances: () => Promise.resolve([]),
    payChallenge: (operation, _challenge, challengeId) => {
      signed.push({ operation, challengeId })
      return Promise.resolve(
        state.pay ?? { outcome: 'uncertain', reason: 'handed over', credential: `token-${challengeId}` },
      )
    },
    confirmChallenge: () => Promise.resolve(state.finding),
  }
  const layer = walletLayer({ ledger, signer: undefined, rails, origin: 'https://wallet.test' })
  return {
    ledger,
    signed,
    state,
    pay: (call: PayChallengeInput) => runWallet(payChallenge(call, 'goblin'), layer),
    report: (operationId: string, receipt: string) => runWallet(reportChallengeReceipt(operationId, receipt), layer),
  }
}

const codeOf = (result: { ok: true } | { ok: false; failure: { code: string } }) =>
  result.ok ? 'ok' : result.failure.code

describe('pay_challenge paying', () => {
  test('signs once and hands back the credential; the same call replays it and never signs again', async () => {
    const h = harness()
    const challenge = header('c1')
    const first = await h.pay(input('op-challenge-0001', challenge))
    if (!first.ok) throw new Error(first.failure.message)
    expect(first.value.credential).toBe('token-c1')
    expect(first.value.outcome).toMatchObject({
      kind: 'done',
      replay: false,
      operation: {
        status: 'uncertain',
        terms: { kind: 'paid_fetch', chain: 'tempo', rail: 'mpp', amountUsd: '0.00075', recipient: OPENROUTER },
      },
    })
    expect(h.signed).toEqual([expect.objectContaining({ challengeId: 'c1' })])
    const again = await h.pay(input('op-challenge-0001', challenge))
    expect(again).toMatchObject({ ok: true, value: { credential: 'token-c1', outcome: { replay: true } } })
    expect(h.signed).toHaveLength(1)
    // The hold stays while the outcome is unknown: the hour has $20 less $0.00075.
    expect(await h.ledger.limitViews()).toContainEqual(
      expect.objectContaining({ period: 'hour', remaining: '19.99925' }),
    )
  })

  test('refuses the same challenge under another operation_id, and another challenge under the same one', async () => {
    const h = harness()
    const challenge = header('c2')
    await h.pay(input('op-challenge-0002', challenge))
    expect(codeOf(await h.pay(input('op-challenge-0003', challenge)))).toBe('challenge_reused')
    expect(codeOf(await h.pay(input('op-challenge-0002', header('c3'))))).toBe('operation_id_reused')
    expect(h.signed).toHaveLength(1)
  })

  test('refuses an unknown payee, a foreign recipient, an expired challenge, a price over max_usd and missing fields', async () => {
    const h = harness()
    const refusals = [
      h.pay(input('op-challenge-0010', header('c10'), { url: 'https://openrouter.example/v1/chat/completions' })),
      h.pay(input('op-challenge-0011', header('c11'), { url: 'http://openrouter.mpp.tempo.xyz/v1/chat' })),
      h.pay(input('op-challenge-0012', header('c12', { recipient: '0x0000000000000000000000000000000000000001' }))),
      h.pay(input('op-challenge-0013', header('c13', { expires: new Date(Date.now() - 1000).toISOString() }))),
      h.pay(input('op-challenge-0014', header('c14', { amount: '30000' }))),
      h.pay(input('op-challenge-0015', entry('c15', { currency: PATH_USD }))),
      h.pay({ operation_id: 'op-challenge-0016', url: URL_OK, method: 'POST', max_usd: '0.02' }),
    ]
    expect((await Promise.all(refusals)).map(codeOf)).toEqual([
      'unknown_payee',
      'unknown_payee',
      'unexpected_recipient',
      'challenge_expired',
      'above_max_usd',
      'bad_challenge',
      'bad_request',
    ])
    expect(h.signed).toHaveLength(0)
  })

  test('a known payee needs no first-use approval, but a spend over the per-call limit waits for the owner', async () => {
    const h = harness()
    const over = await h.pay(input('op-challenge-0020', header('c20', { amount: '6000000' }), { max_usd: '6' }))
    expect(over).toMatchObject({ ok: true, value: { outcome: { kind: 'awaiting_approval' } } })
    expect(over.ok && over.value.credential).toBeUndefined()
    expect(h.signed).toHaveLength(0)
  })

  test('a refusal at signing fails the operation and releases the hold, with no credential', async () => {
    const h = harness()
    h.state.pay = { outcome: 'failed', reason: 'The challenge is not the one this operation froze.' }
    const failed = await h.pay(input('op-challenge-0030', header('c30')))
    expect(failed).toMatchObject({ ok: true, value: { outcome: { operation: { status: 'failed' } } } })
    expect(failed.ok && failed.value.credential).toBeUndefined()
    expect(await h.ledger.limitViews()).toContainEqual(expect.objectContaining({ period: 'hour', remaining: '20' }))
  })
})

describe('pay_challenge reporting a receipt', () => {
  test('a receipt the chain confirms settles the operation, and reporting again answers paid', async () => {
    const h = harness()
    await h.pay(input('op-challenge-0040', header('c40')))
    const settled = await h.report('op-challenge-0040', 'receipt')
    expect(settled).toMatchObject({ ok: true, value: { found: 'paid', operation: { status: 'delivered' } } })
    expect(settled.ok && settled.value.operation.payment?.txHash).toBe(`0x${'ab'.repeat(32)}`)
    expect(await h.report('op-challenge-0040', 'receipt')).toMatchObject({ ok: true, value: { found: 'paid' } })
  })

  test('a transaction Tempo does not show yet leaves it unknown; a mismatch is refused and leaves it unknown too', async () => {
    const h = harness()
    await h.pay(input('op-challenge-0041', header('c41')))
    h.state.finding = { kind: 'unknown', reason: 'Tempo does not show that transaction yet.' }
    expect(await h.report('op-challenge-0041', 'receipt')).toMatchObject({
      ok: true,
      value: { found: 'unknown', operation: { status: 'uncertain' } },
    })
    h.state.finding = { kind: 'mismatch', reason: 'The receipt names a transaction that reverted.' }
    expect(codeOf(await h.report('op-challenge-0041', 'receipt'))).toBe('receipt_mismatch')
    expect((await h.ledger.operation('op-challenge-0041'))?.status).toBe('uncertain')
  })

  test('refuses a receipt for an operation that signed no challenge, or one that does not exist', async () => {
    const h = harness()
    h.state.pay = { outcome: 'failed', reason: 'refused' }
    await h.pay(input('op-challenge-0042', header('c42')))
    expect(codeOf(await h.report('op-challenge-0042', 'receipt'))).toBe('not_a_challenge')
    expect(codeOf(await h.report('op-challenge-0043', 'receipt'))).toBe('unknown_operation')
  })
})
