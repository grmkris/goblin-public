import type { Hex } from 'viem'
import { describe, expect, test } from 'vitest'
import { TEMPO } from '../chains/index.ts'
import {
  b64url,
  challengeHeader,
  exaFetch,
  fakeAgent,
  fakeNode,
  local,
  RECEIPT_TX,
  receipt,
  RECIPIENT,
  REQUEST,
  sentTransaction,
  TERMS,
} from './fixtures.ts'
import {
  assertCalls,
  assertFee,
  payMpp,
  probeMpp,
  transferTempoUsdc,
  type TempoAgent,
  type TempoTerms,
} from './index.ts'

describe('MPP probe', () => {
  test('a Tempo USDC.e charge challenge becomes a quote', async () => {
    const probe = await probeMpp(REQUEST, exaFetch(challengeHeader(), () => new Response('ok')).fn)
    expect(probe).toMatchObject({ kind: 'quote', quote: { terms: TERMS, amountUsd: '0.007' } })
  })

  test('another currency is unsupported; a 200 is free', async () => {
    const other = challengeHeader().replace(
      /request="[^"]+"/u,
      `request="${b64url({ amount: '1', currency: '0x0000000000000000000000000000000000000001', recipient: RECIPIENT })}"`,
    )
    expect((await probeMpp(REQUEST, exaFetch(other, () => new Response('ok')).fn)).kind).toBe('unsupported')
    expect((await probeMpp(REQUEST, async () => new Response('hi'))).kind).toBe('free')
  })
})

/** A service that answers every request, paid or not, with a fresh 402. */
const answers402 = async () => new Response('{}', { status: 402, headers: { 'www-authenticate': challengeHeader() } })

/** A connection that drops once the credential is sent. */
const dropsPaid = async (_input: string | URL | Request, init?: RequestInit) => {
  if (new Headers(init?.headers).has('authorization')) throw new Error('socket closed')
  return answers402()
}

describe('MPP payment', () => {
  test('builds a sponsored pull transfer to the recipient, signs it via the agent and sends the credential', async () => {
    const { agent, signed } = fakeAgent()
    const net = exaFetch(
      challengeHeader(),
      () => new Response('{"results":[]}', { status: 200, headers: { 'payment-receipt': receipt() } }),
    )
    const paid = await payMpp({
      request: REQUEST,
      terms: TERMS,
      maxUsd: '0.05',
      agent,
      operationKey: 'op-mpp-0001',
      fetchFn: net.fn,
      client: fakeNode().client,
      now: () => new Date('2026-10-12T06:00:00Z'),
    })
    expect(paid.outcome).toBe('settled')
    expect(paid.payment).toMatchObject({
      rail: 'mpp',
      txHash: RECEIPT_TX,
      explorerUrl: `https://explore.tempo.xyz/tx/${RECEIPT_TX}`,
    })
    expect(signed).toHaveLength(1)
    // Privy has no `fee_payer` flag: the sponsored form is asked for with a placeholder fee-payer signature.
    expect(signed[0]).toMatchObject({ type: 118, chain_id: 4217, fee_payer_signature: { y_parity: 1 } })
    expect(signed[0]?.fee_token).toBeUndefined()
    expect(signed[0]?.calls).toHaveLength(1)
    expect(signed[0]?.calls[0]?.to.toLowerCase()).toBe(TEMPO.usdc.address.toLowerCase())
    const authorization = net.calls.at(-1)?.headers.get('authorization') ?? ''
    expect(authorization.startsWith('Payment ')).toBe(true)
    // The credential carries the sponsored envelope (the 0x00 marker, no placeholder), signed by the agent.
    const sent = sentTransaction(authorization)
    expect(sent.feePayerSignature).toBeNull()
    expect(sent.from?.toLowerCase()).toBe(local.address.toLowerCase())
  })

  test('refuses a signature over the unsponsored payload before the credential exists', async () => {
    const { agent } = fakeAgent()
    const unsponsored: TempoAgent = {
      ...agent,
      signTempoTransaction: ({ operationKey, transaction }) => {
        const { fee_payer_signature: _placeholder, ...rest } = transaction
        return agent.signTempoTransaction({ operationKey, transaction: rest })
      },
    }
    const net = exaFetch(challengeHeader(), () => new Response('{}', { status: 200 }))
    const paying = payMpp({
      request: REQUEST,
      terms: TERMS,
      maxUsd: '0.05',
      agent: unsponsored,
      operationKey: 'op-mpp-0005',
      fetchFn: net.fn,
      client: fakeNode().client,
    })
    await expect(paying).rejects.toMatchObject({ code: 'sign_failed' })
    expect(net.calls.some((call) => call.headers.has('authorization'))).toBe(false)
  })

  test('refuses above max_usd, a changed recipient and a changed price without signing', async () => {
    const { agent, signed } = fakeAgent()
    const run = (terms: TempoTerms, maxUsd: string, header = challengeHeader()) =>
      payMpp({
        request: REQUEST,
        terms,
        maxUsd,
        agent,
        operationKey: 'op-mpp-0002',
        fetchFn: exaFetch(header, () => new Response('no')).fn,
        client: fakeNode().client,
      })
    await expect(run(TERMS, '0.005')).rejects.toMatchObject({ code: 'above_cap' })
    await expect(
      run({ ...TERMS, recipient: '0x0000000000000000000000000000000000000001' }, '0.05'),
    ).rejects.toMatchObject({ code: 'terms_changed' })
    await expect(run(TERMS, '0.05', challengeHeader({ amount: '9000' }))).rejects.toMatchObject({
      code: 'terms_changed',
    })
    expect(signed).toHaveLength(0)
  })

  test('a 402 after the credential is unknown, never unsettled: the service may still redeem it', async () => {
    const { agent } = fakeAgent()
    const paid = await payMpp({
      request: REQUEST,
      terms: TERMS,
      maxUsd: '0.05',
      agent,
      operationKey: 'op-mpp-0004',
      fetchFn: answers402,
      client: fakeNode().client,
    })
    expect(paid.outcome).toBe('unknown')
  })

  test('a transport failure after the credential is unknown', async () => {
    const { agent } = fakeAgent()
    const paid = await payMpp({
      request: REQUEST,
      terms: TERMS,
      maxUsd: '0.05',
      agent,
      operationKey: 'op-mpp-0003',
      fetchFn: dropsPaid,
      client: fakeNode().client,
    })
    expect(paid.outcome).toBe('unknown')
  })
})

const transfer = (to: string, amount: bigint) =>
  `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`

describe('Tempo call guard', () => {
  const token = TEMPO.usdc.address
  const allow = { recipient: RECIPIENT, maxAtomic: 10_000n }

  test('accepts the approved transfer and refuses everything else', () => {
    expect(() => assertCalls([{ to: token, data: transfer(RECIPIENT, 7000n) }], allow)).not.toThrow()
    expect(() => assertCalls([{ to: token, data: transfer(RECIPIENT, 20_000n) }], allow)).toThrow(/more than approved/u)
    expect(() =>
      assertCalls([{ to: token, data: transfer('0x0000000000000000000000000000000000000001', 1n) }], allow),
    ).toThrow(/someone other/u)
    expect(() =>
      assertCalls([{ to: '0x0000000000000000000000000000000000000001', data: transfer(RECIPIENT, 1n) }], allow),
    ).toThrow(/something other/u)
    expect(() => assertCalls([], allow)).toThrow()
  })
})

describe('Tempo fee ceiling', () => {
  test('refuses a worst-case fee above the ceiling and allows a transfer-sized one', () => {
    // 0x30000 gas at 600 gwei-scale (the live Tempo price) is about 118 base units of USDC.e.
    expect(() => assertFee({ gas: 0x30000n, maxFeePerGas: 600_000_000n })).not.toThrow()
    expect(() => assertFee({ gas: 1_000_000n, maxFeePerGas: 60_000_000_000_000n })).toThrow(
      /above the wallet's ceiling/u,
    )
    expect(() => assertFee({ gas: 1_000_000n, maxFeePerGas: 50_000_000_000n }, 49_999n)).toThrow(/ceiling/u)
    expect(() => assertFee({})).not.toThrow()
  })
})

describe('Tempo transfer', () => {
  test('signs a USDC.e transfer with USDC.e as fee token and broadcasts the stored bytes', async () => {
    const { agent, signed } = fakeAgent()
    const node = fakeNode()
    const stored: Hex[] = []
    const result = await transferTempoUsdc({
      agent,
      to: RECIPIENT,
      amount: 1_500_000n,
      operationKey: 'op-tr-0001',
      client: node.client,
      onSigned: async ({ raw }) => {
        stored.push(raw)
      },
    })
    expect(result).toMatchObject({
      status: 'success',
      explorerUrl: `https://explore.tempo.xyz/tx/0x${'22'.repeat(32)}`,
    })
    expect(signed[0]?.fee_token?.toLowerCase()).toBe(TEMPO.usdc.address.toLowerCase())
    expect(signed[0]?.fee_payer_signature).toBeUndefined()
    expect(node.sent).toEqual(stored)
  })
})
