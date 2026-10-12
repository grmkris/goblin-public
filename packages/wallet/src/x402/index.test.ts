import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem/utils'
import { describe, expect, test } from 'vitest'
import { toHex } from '../balances/hex.ts'
import { BASE } from '../chains/index.ts'
import type { AgentSigner, TypedDataJson } from '../contract/index.ts'
import { EXA_PAYMENT_REQUIRED } from './fixtures/exa-402.ts'
import {
  isPlainBaseOffer,
  payX402,
  probeX402,
  selectBaseOffer,
  X402_NETWORK,
  X402Error,
  type PaidRequest,
} from './index.ts'

const account = privateKeyToAccount(generatePrivateKey())
const request: PaidRequest = {
  method: 'POST',
  url: 'https://api.exa.ai/search',
  headers: { 'content-type': 'application/json' },
  body: '{"query":"goblin","numResults":3}',
}

const bigintTypes = new Set(['uint256'])

/** A local-account AgentSigner that records what it was asked to sign. */
const agent = () => {
  const signed: TypedDataJson[] = []
  const signer: AgentSigner = {
    address: account.address,
    signTypedData: async ({ typedData }) => {
      signed.push(typedData)
      const fields = typedData.types[typedData.primaryType] ?? []
      const message = Object.fromEntries(
        Object.entries(typedData.message).map(([key, value]) => [
          key,
          bigintTypes.has(fields.find((f) => f.name === key)?.type ?? '') ? BigInt(String(value)) : value,
        ]),
      )
      const domain = { ...typedData.domain, chainId: BigInt(String(typedData.domain['chainId'])) }
      return account.signTypedData({ domain, types: typedData.types, primaryType: typedData.primaryType, message })
    },
    sendTransaction: async () => {
      throw new Error('not used')
    },
    signAuthorization: async () => {
      throw new Error('not used')
    },
  }
  return { signer, signed }
}

const TX = `0x${'ab'.repeat(32)}`
const settleHeader = (success = true) =>
  btoa(JSON.stringify({ success, transaction: success ? TX : '', network: X402_NETWORK, payer: account.address }))

const fakeFetch = (paidResponse: () => Response) => {
  const calls: { headers: Headers; body: string | undefined }[] = []
  const fn = async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    calls.push({ headers, body: typeof init.body === 'string' ? init.body : undefined })
    if (headers.has('payment-signature')) return paidResponse()
    return new Response('{}', { status: 402, headers: { 'payment-required': EXA_PAYMENT_REQUIRED } })
  }
  return { fn, calls }
}

const down = async (_url: string, init: RequestInit) => {
  if (new Headers(init.headers).has('payment-signature')) throw new Error('socket closed')
  return new Response('{}', { status: 402, headers: { 'payment-required': EXA_PAYMENT_REQUIRED } })
}

const quoteOf = async () => {
  const probe = await probeX402(request, fakeFetch(() => new Response('ok')).fn)
  if (probe.kind !== 'quote') throw new Error('expected a quote')
  return probe.quote
}

describe('x402 offers', () => {
  test('the network constant matches the chain table', () => {
    expect(X402_NETWORK).toBe(BASE.caip2)
  })

  test('the Exa challenge yields the plain Base USDC offer, not Solana or Circle Gateway', async () => {
    const quote = await quoteOf()
    expect(quote.terms).toEqual({
      network: 'eip155:8453',
      asset: BASE.usdc.address,
      recipient: '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC',
      amount: '7000',
    })
    expect(quote.amountUsd).toBe('0.007')
    const plain = quote.paymentRequired.accepts.filter(isPlainBaseOffer)
    expect(plain).toHaveLength(2)
    expect(selectBaseOffer(quote.paymentRequired)?.extra?.['assetTransferMethod']).toBe('eip3009')
  })

  test('a non-402 answer is returned as free; a 402 without x402 is unsupported', async () => {
    const free = await probeX402(request, async () => new Response('hi'))
    expect(free.kind).toBe('free')
    const other = await probeX402(request, async () => new Response('pay', { status: 402 }))
    expect(other).toEqual({ kind: 'unsupported', status: 402 })
  })
})

describe('x402 payment', () => {
  test('signs one EIP-3009 authorization from the agent and records the settlement', async () => {
    const quote = await quoteOf()
    const { signer, signed } = agent()
    const net = fakeFetch(
      () => new Response('{"results":[]}', { status: 200, headers: { 'payment-response': settleHeader() } }),
    )
    const paid = await payX402({
      request,
      terms: quote.terms,
      maxUsd: '0.05',
      agent: signer,
      operationKey: 'op-x402-1',
      fetchFn: net.fn,
      now: () => new Date('2026-10-12T06:00:00Z'),
    })
    expect(paid.outcome).toBe('settled')
    expect(paid.payment).toMatchObject({
      rail: 'x402',
      txHash: TX,
      explorerUrl: `https://basescan.org/tx/${TX}`,
      settledAt: '2026-10-12T06:00:00.000Z',
    })
    expect(signed).toHaveLength(1)
    expect(signed[0]?.primaryType).toBe('TransferWithAuthorization')
    expect(signed[0]?.domain).toMatchObject({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: BASE.usdc.address,
    })
    expect(signed[0]?.message).toMatchObject({ from: account.address, to: quote.terms.recipient, value: '7000' })
    // The retried request carries the same body and a PAYMENT-SIGNATURE that decodes back to the signed authorization.
    const retry = net.calls.at(-1)
    expect(retry?.body).toBe(request.body)
    const payload = JSON.parse(atob(retry?.headers.get('payment-signature') ?? ''))
    expect(payload.accepted.payTo).toBe(quote.terms.recipient)
    const authorization = payload.payload.authorization
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE.usdc.address },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: toHex(authorization.nonce),
      },
      signature: toHex(payload.payload.signature),
    })
    expect(recovered).toBe(account.address)
  })

  test('refuses above max_usd without signing', async () => {
    const quote = await quoteOf()
    const { signer, signed } = agent()
    const net = fakeFetch(() => new Response('no'))
    await expect(
      payX402({
        request,
        terms: quote.terms,
        maxUsd: '0.005',
        agent: signer,
        operationKey: 'op-x402-2',
        fetchFn: net.fn,
      }),
    ).rejects.toMatchObject({ code: 'above_cap' })
    expect(signed).toHaveLength(0)
    expect(net.calls.every((call) => !call.headers.has('payment-signature'))).toBe(true)
  })

  test('refuses when the live recipient differs from the approved terms', async () => {
    const quote = await quoteOf()
    const { signer, signed } = agent()
    const net = fakeFetch(() => new Response('no'))
    const changed = { ...quote.terms, recipient: '0x0000000000000000000000000000000000000001' }
    const failure = payX402({
      request,
      terms: changed,
      maxUsd: '0.05',
      agent: signer,
      operationKey: 'op-x402-3',
      fetchFn: net.fn,
    })
    await expect(failure).rejects.toBeInstanceOf(X402Error)
    await expect(failure).rejects.toMatchObject({ code: 'terms_changed' })
    expect(signed).toHaveLength(0)
  })

  test('a transport failure after signing is unknown, a 402 again is unknown too (the credential is out), a 500 without receipt is unknown', async () => {
    const quote = await quoteOf()
    const run = async (answer: () => Response) =>
      payX402({
        request,
        terms: quote.terms,
        maxUsd: '0.05',
        agent: agent().signer,
        operationKey: 'op-x402-4',
        fetchFn: fakeFetch(answer).fn,
      })
    const failed = await run(() => new Response('', { status: 500 }))
    expect(failed.outcome).toBe('unknown')
    // The unknown outcome keeps the signed authorization so it can be checked on chain, never resent.
    expect(failed.payment).toMatchObject({
      rail: 'x402',
      authorization: {
        from: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/u),
        nonce: expect.stringMatching(/^0x[0-9a-fA-F]{64}$/u),
        validBefore: expect.stringMatching(/^\d+$/u),
      },
    })
    expect(failed.payment?.settledAt).toBeUndefined()
    expect(
      (await run(() => new Response('', { status: 402, headers: { 'payment-required': EXA_PAYMENT_REQUIRED } })))
        .outcome,
    ).toBe('unknown')
    const lost = await payX402({
      request,
      terms: quote.terms,
      maxUsd: '0.05',
      agent: agent().signer,
      operationKey: 'op-x402-5',
      fetchFn: down,
    })
    expect(lost.outcome).toBe('unknown')
    expect(lost.payment?.authorization?.nonce).toMatch(/^0x[0-9a-fA-F]{64}$/u)
  })
})
