import { createClient, custom, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoChain } from 'viem/chains'
import { describe, expect, test } from 'vitest'
import { toHex } from '../balances/hex.ts'
import { TEMPO } from '../chains/index.ts'
import {
  assertCalls,
  payMpp,
  probeMpp,
  transferTempoUsdc,
  type TempoAgent,
  type TempoTerms,
  type TempoTransactionJson,
} from './index.ts'

const local = privateKeyToAccount(generatePrivateKey())
const RECIPIENT = '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC'
const REQUEST = { method: 'POST', url: 'https://api.exa.ai/search', body: '{"query":"goblin"}' } as const
const TERMS: TempoTerms = { network: 'eip155:4217', asset: TEMPO.usdc.address, recipient: RECIPIENT, amount: '7000' }

const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

const challengeHeader = (overrides: { amount?: string; recipient?: string; expires?: string } = {}) => {
  const request = {
    amount: overrides.amount ?? '7000',
    currency: TEMPO.usdc.address,
    methodDetails: { chainId: 4217, feePayer: true, supportedModes: ['pull'] },
    recipient: overrides.recipient ?? RECIPIENT,
  }
  const expires = overrides.expires ?? new Date(Date.now() + 240_000).toISOString()
  return `Payment id="abc123", realm="api.exa.ai", method="tempo", intent="charge", request="${b64url(request)}", expires="${expires}"`
}

/** An AgentSigner whose Tempo signing rebuilds the viem transaction from the JSON and signs it locally. */
const fakeAgent = () => {
  const signed: TempoTransactionJson[] = []
  const agent: TempoAgent = {
    address: local.address,
    signTypedData: () => Promise.reject(new Error('not used')),
    sendTransaction: () => Promise.reject(new Error('not used')),
    signAuthorization: () => Promise.reject(new Error('not used')),
    signTempoTransaction: async ({ transaction }) => {
      signed.push(transaction)
      // SAFETY: the JSON rebuilds a viem Tempo transaction request; viem's account types do not model chain-specific types.
      return local.signTransaction(
        {
          type: 'tempo',
          chainId: transaction.chain_id,
          nonce: Number(BigInt(transaction.nonce)),
          nonceKey: BigInt(transaction.nonce_key),
          gas: BigInt(transaction.gas_limit),
          maxFeePerGas: BigInt(transaction.max_fee_per_gas),
          maxPriorityFeePerGas: BigInt(transaction.max_priority_fee_per_gas),
          calls: transaction.calls.map((call) => ({
            to: toHex(call.to),
            data: toHex(call.data),
            value: BigInt(call.value),
          })),
          ...(transaction.valid_before === undefined ? {} : { validBefore: Number(BigInt(transaction.valid_before)) }),
          ...(transaction.fee_payer === true ? { feePayer: true } : {}),
          ...(transaction.fee_token === undefined ? {} : { feeToken: toHex(transaction.fee_token) }),
        } as never,
        { serializer: tempoChain.serializers?.transaction },
      )
    },
  }
  return { agent, signed }
}

/** A fake Tempo node: fills transactions the way `eth_fillTransaction` does and accepts raw sends. */
const fakeNode = () => {
  const sent: string[] = []
  const client = createClient({
    chain: tempoChain,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        const first = Array.isArray(params) ? params[0] : undefined
        switch (method) {
          case 'eth_chainId':
            return '0x1079'
          case 'eth_fillTransaction':
            return {
              tx: {
                ...first,
                type: '0x76',
                chainId: '0x1079',
                nonce: '0x0',
                gas: '0x30000',
                maxFeePerGas: '0x23c34600',
                maxPriorityFeePerGas: '0x0',
                hash: `0x${'11'.repeat(32)}`,
                input: '0x',
                value: '0x0',
              },
              raw: '0x',
            }
          case 'eth_sendRawTransactionSync':
            sent.push(String(first))
            return {
              transactionHash: `0x${'22'.repeat(32)}`,
              status: '0x1',
              blockNumber: '0x1',
              blockHash: `0x${'33'.repeat(32)}`,
              transactionIndex: '0x0',
              from: local.address,
              to: TEMPO.usdc.address,
              cumulativeGasUsed: '0x1',
              gasUsed: '0x1',
              effectiveGasPrice: '0x1',
              logs: [],
              logsBloom: `0x${'00'.repeat(256)}`,
              type: '0x76',
              contractAddress: null,
            }
          default:
            throw new Error(`unexpected ${method}`)
        }
      },
    }),
  })
  return { client, sent }
}

const exaFetch = (header: string, paid: () => Response) => {
  const calls: { headers: Headers }[] = []
  const fn = async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ headers })
    if (headers.has('authorization')) return paid()
    return new Response('{}', { status: 402, headers: { 'www-authenticate': header } })
  }
  return { fn, calls }
}

const RECEIPT_TX = `0x${'ee'.repeat(32)}`
const receipt = () =>
  b64url({ method: 'tempo', reference: RECEIPT_TX, status: 'success', timestamp: '2026-10-12T06:00:00Z' })

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
    expect(signed[0]).toMatchObject({ type: 118, chain_id: 4217, fee_payer: true })
    expect(signed[0]?.fee_token).toBeUndefined()
    expect(signed[0]?.calls).toHaveLength(1)
    expect(signed[0]?.calls[0]?.to.toLowerCase()).toBe(TEMPO.usdc.address.toLowerCase())
    const authorization = net.calls.at(-1)?.headers.get('authorization') ?? ''
    expect(authorization.startsWith('Payment ')).toBe(true)
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
    const fn = async () => new Response('{}', { status: 402, headers: { 'www-authenticate': challengeHeader() } })
    const paid = await payMpp({
      request: REQUEST,
      terms: TERMS,
      maxUsd: '0.05',
      agent,
      operationKey: 'op-mpp-0004',
      fetchFn: fn,
      client: fakeNode().client,
    })
    expect(paid.outcome).toBe('unknown')
  })

  test('a transport failure after the credential is unknown', async () => {
    const { agent } = fakeAgent()
    const fn = async (_input: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).has('authorization')) throw new Error('socket closed')
      return new Response('{}', { status: 402, headers: { 'www-authenticate': challengeHeader() } })
    }
    const paid = await payMpp({
      request: REQUEST,
      terms: TERMS,
      maxUsd: '0.05',
      agent,
      operationKey: 'op-mpp-0003',
      fetchFn: fn,
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
    expect(signed[0]?.fee_payer).toBeUndefined()
    expect(node.sent).toEqual(stored)
  })
})
