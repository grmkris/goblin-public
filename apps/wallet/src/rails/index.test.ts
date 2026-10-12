import { toHex, type JsonRpc } from '@goblin/wallet/balances'
import type { AgentSigner, Operation, ServiceRule, Terms } from '@goblin/wallet/contract'
import { DEFAULT_SERVICES, termsHash } from '@goblin/wallet/contract'
import { describe, expect, test, vi } from 'vitest'
import { TOP_UP_SETTLE_MS } from './fetch.ts'
import { createRails, type RailsDeps } from './index.ts'

const AGENT = '0x03582783c8e71b0c2D3b607E0FBdec7402f76F77'
const OWNER = '0x7Ff152896986BDC96a37e8a8eCeF454733318b33'
const PAY_TO = '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const NOW = new Date('2026-10-12T06:00:00Z')
const EXA: ServiceRule = DEFAULT_SERVICES.find((service) => service.id === 'exa.search') ?? failTest()
function failTest(): never {
  throw new Error('the default services lack exa.search')
}
const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`
const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

const x402Header = btoa(
  JSON.stringify({
    x402Version: 2,
    resource: { url: EXA.url },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '7000',
        asset: BASE_USDC,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
      },
    ],
  }),
)
const mppHeader = (amount = '7000') =>
  `Payment id="abc", realm="api.exa.ai", method="tempo", intent="charge", request="${b64url({
    amount,
    currency: '0x20C000000000000000000000b9537d11c60E8b50',
    methodDetails: { chainId: 4217, feePayer: true, supportedModes: ['pull'] },
    recipient: PAY_TO,
  })}", expires="${new Date(Date.now() + 240_000).toISOString()}"`

const settle = btoa(
  JSON.stringify({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:8453', payer: AGENT }),
)

const signer = (): AgentSigner & { sent: string[] } => {
  const sent: string[] = []
  return {
    sent,
    address: AGENT,
    signTypedData: async () => `0x${'11'.repeat(65)}`,
    signAuthorization: () => Promise.reject(new Error('unused')),
    sendTransaction: async ({ to }) => {
      sent.push(to)
      return `0x${sent.length.toString(16).padStart(64, '0')}`
    },
  }
}

const deps = (overrides: Partial<RailsDeps> = {}): RailsDeps => ({
  live: true,
  signer: signer(),
  profile: async () => ({ ownerAddress: OWNER, agentAddress: AGENT, chains: [] }),
  rpcFor: () => async () => word(10_000_000n),
  now: () => NOW,
  wait: { sleep: async () => undefined, attempts: 2 },
  ...overrides,
})

const exaFetch =
  (options: { paid?: () => Response; mpp?: boolean; x402?: boolean } = {}): typeof fetch =>
  async (_input, init) => {
    const headers = new Headers(init?.headers)
    if (headers.has('payment-signature'))
      return options.paid?.() ?? new Response('{}', { status: 200, headers: { 'payment-response': settle } })
    const extra: Record<string, string> = {}
    if (options.x402 !== false) extra['payment-required'] = x402Header
    if (options.mpp !== false) extra['www-authenticate'] = mppHeader()
    return new Response('{}', { status: 402, headers: extra })
  }

const operation = (terms: Terms): Operation => ({
  id: 'op-rails-test-01',
  status: 'reserved',
  terms,
  termsHash: `0x${'00'.repeat(32)}`,
  limitsVersion: 1,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
})

describe('paid fetch', () => {
  test('quotes the cheapest rail, preferring Base x402 on a tie, and honors a requested rail', async () => {
    const rails = createRails(deps({ fetchFn: exaFetch() }))
    const terms = await rails.quotePaidFetch(EXA, { query: 'goblin' })
    expect(terms).toMatchObject({
      kind: 'paid_fetch',
      chain: 'base',
      rail: 'x402',
      amount: '0.007',
      amountUsd: '0.007',
      recipient: PAY_TO,
      subject: 'exa.search',
      request: { method: 'POST', url: EXA.url },
    })
    const mpp = await rails.quotePaidFetch(EXA, { query: 'goblin' }, 'mpp')
    expect(mpp).toMatchObject({ chain: 'tempo', rail: 'mpp', token: { symbol: 'USDC.e' }, amountUsd: '0.007' })
  })

  test('a testnet wallet neither quotes nor pays a paid service, which settles on mainnet only', async () => {
    const quote = await createRails(deps({ fetchFn: exaFetch() })).quotePaidFetch(EXA, {}, 'x402')
    const rails = createRails(deps({ live: false, fetchFn: exaFetch() }))
    await expect(rails.quotePaidFetch(EXA, {})).rejects.toThrow(/mainnet payments only/u)
    expect(await rails.payPaidFetch(operation(quote), EXA, {})).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('mainnet payments only'),
    })
  })

  test('refuses a service that offers no price on an allowed rail', async () => {
    const rails = createRails(deps({ fetchFn: async () => new Response('free', { status: 200 }) }))
    await expect(rails.quotePaidFetch(EXA, {})).rejects.toThrow(/no price/u)
  })

  test('pays over x402 and returns the settlement with the bounded response', async () => {
    const rails = createRails(
      deps({
        fetchFn: exaFetch({
          paid: () => Response.json({ results: [1, 2] }, { headers: { 'payment-response': settle } }),
        }),
      }),
    )
    const terms = await rails.quotePaidFetch(EXA, { query: 'goblin' }, 'x402')
    const outcome = await rails.payPaidFetch(operation(terms), EXA, { query: 'goblin' })
    expect(outcome).toMatchObject({
      outcome: 'settled',
      payment: { rail: 'x402', txHash: `0x${'ab'.repeat(32)}` },
      delivery: { status: '200' },
      response: { status: 200, body: { results: [1, 2] }, truncated: false },
    })
  })

  test('a 402 after the credential is uncertain; a silent paid answer is uncertain; no signer is failed', async () => {
    const terms = await createRails(deps({ fetchFn: exaFetch() })).quotePaidFetch(EXA, {}, 'x402')
    const refused = createRails(
      deps({
        fetchFn: exaFetch({
          paid: () => new Response('no', { status: 402, headers: { 'payment-required': x402Header } }),
        }),
      }),
    )
    expect((await refused.payPaidFetch(operation(terms), EXA, {})).outcome).toBe('uncertain')
    const silent = createRails(deps({ fetchFn: exaFetch({ paid: () => new Response('boom', { status: 500 }) }) }))
    expect((await silent.payPaidFetch(operation(terms), EXA, {})).outcome).toBe('uncertain')
    const nobody = createRails(deps({ signer: undefined, fetchFn: exaFetch() }))
    expect((await nobody.payPaidFetch(operation(terms), EXA, {})).outcome).toBe('failed')
  })

  test('a paid response whose body breaks keeps the settlement and reports delivery failed', async () => {
    const terms = await createRails(deps({ fetchFn: exaFetch() })).quotePaidFetch(EXA, {}, 'x402')
    const broken = new ReadableStream<Uint8Array>({
      pull: () => {
        throw new Error('stream reset')
      },
    })
    const rails = createRails(
      deps({
        fetchFn: exaFetch({ paid: () => new Response(broken, { headers: { 'payment-response': settle } }) }),
      }),
    )
    const outcome = await rails.payPaidFetch(operation(terms), EXA, {})
    expect(outcome).toMatchObject({
      outcome: 'settled',
      payment: { rail: 'x402', txHash: `0x${'ab'.repeat(32)}` },
      delivery: { status: 'failed' },
    })
  })

  test('the paid body is bounded while streaming: an endless body is cut and cancelled', async () => {
    const terms = await createRails(deps({ fetchFn: exaFetch() })).quotePaidFetch(EXA, {}, 'x402')
    let pulls = 0
    let cancelled = false
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1
        controller.enqueue(new Uint8Array(10_000).fill(97))
      },
      cancel: () => {
        cancelled = true
      },
    })
    const rails = createRails(
      deps({
        fetchFn: exaFetch({
          paid: () => new Response(endless, { headers: { 'payment-response': settle, 'content-type': 'text/plain' } }),
        }),
      }),
    )
    const outcome = await rails.payPaidFetch(operation(terms), EXA, {})
    expect(outcome).toMatchObject({ outcome: 'settled', response: { truncated: true } })
    expect(outcome.outcome === 'settled' && String(outcome.response?.body).length).toBe(32_000)
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
  })

  test('after an allowance top-up, the x402 payment waits for the new balance to settle before it signs', async () => {
    const slept: number[] = []
    let toppedUp = false
    const empty: JsonRpc = async (method) => {
      if (method === 'eth_getTransactionReceipt') return { status: '0x1' }
      // Once the top-up's receipt is in, the agent holds the USDC it asked for.
      if (method === 'eth_call' && toppedUp) return word(10_000_000n)
      if (method === 'eth_getBlockByNumber') return { baseFeePerGas: '0x989680' }
      if (method === 'eth_estimateGas') return '0x186a0'
      if (method === 'eth_maxPriorityFeePerGas') return '0xf4240'
      return method === 'eth_getBalance' ? word(10n ** 15n) : word(0n)
    }
    const rails = createRails(
      deps({
        rpcFor: () => empty,
        topUp: async () => ({
          redeemCalldata: () => {
            toppedUp = true
            return '0xfeed'
          },
          available: async () => 20_000_000n,
        }),
        wait: { attempts: 2, sleep: async (ms) => void slept.push(ms) },
        fetchFn: exaFetch(),
      }),
    )
    const terms = await rails.quotePaidFetch(EXA, {}, 'x402')
    expect(await rails.payPaidFetch(operation(terms), EXA, {})).toMatchObject({ outcome: 'settled' })
    expect(slept).toContain(TOP_UP_SETTLE_MS)
  })

  test('a price rise since the quote is failed before anything is signed', async () => {
    const cheap = await createRails(deps({ fetchFn: exaFetch() })).quotePaidFetch(EXA, {}, 'x402')
    const cheaper = { ...cheap, amount: '0.001', amountUsd: '0.001' }
    const rails = createRails(deps({ fetchFn: exaFetch() }))
    const outcome = await rails.payPaidFetch(operation(cheaper), EXA, {})
    expect(outcome).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('changed') })
  })
})

describe('transfer', () => {
  const input = {
    chain: 'base',
    token: 'USDC',
    to: PAY_TO,
    amount: '1.5',
    max_usd: '2',
    operation_id: 'op-transfer-01',
  } as const

  test('quotes stablecoin terms at face value and refuses another token', async () => {
    const rails = createRails(deps())
    expect(await rails.quoteTransfer(input)).toMatchObject({
      kind: 'transfer',
      rail: 'transfer',
      amountUsd: '1.5',
      recipient: PAY_TO,
      token: { symbol: 'USDC' },
    })
    await expect(rails.quoteTransfer({ ...input, token: 'PEPE' })).rejects.toThrow(/not a token/u)
  })

  test('pays from the agent balance, or reports why it cannot', async () => {
    const rich: JsonRpc = async (method) =>
      method === 'eth_getTransactionReceipt' ? { status: '0x1' } : word(5_000_000n)
    const rails = createRails(deps({ rpcFor: () => rich }))
    const terms = await rails.quoteTransfer(input)
    const outcome = await rails.transfer(operation(terms))
    expect(outcome).toMatchObject({
      outcome: 'settled',
      payment: { rail: 'transfer', explorerUrl: expect.stringContaining('basescan.org/tx/') },
    })
    const poor: JsonRpc = async (method) => (method === 'eth_getBalance' ? word(10n ** 15n) : word(0n))
    const broke = await createRails(deps({ rpcFor: () => poor })).transfer(operation(terms))
    expect(broke).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('holds') })
  })

  test('a signer that fails mid-send is uncertain', async () => {
    const rich: JsonRpc = async () => word(5_000_000n)
    const flaky: AgentSigner = { ...signer(), sendTransaction: () => Promise.reject(new Error('timeout')) }
    const rails = createRails(deps({ signer: flaky, rpcFor: () => rich }))
    const outcome = await rails.transfer(operation(await rails.quoteTransfer(input)))
    expect(outcome.outcome).toBe('uncertain')
  })
})

describe('balances and allowances', () => {
  test('lists gas and USDC for the agent and the owner', async () => {
    const rails = createRails(deps({ rpcFor: () => async () => word(1_000_000n) }))
    const rows = await rails.balances()
    expect(
      rows.filter((row) => row.chain === 'base').map((row) => `${row.holder}:${row.symbol}:${row.balance}`),
    ).toEqual(['agent:ETH:0.000000000001', 'agent:USDC:1', 'owner:ETH:0.000000000001', 'owner:USDC:1'])
    expect(rows.find((row) => row.chain === 'tempo')?.symbol).toBe('USDC.e')
  })

  test('reads the remaining on-chain allowance from the enforcer', async () => {
    const terms = `0x${BASE_USDC.slice(2)}${'0'.repeat(58)}4c4b40${'0'.repeat(61)}e10${'0'.repeat(56)}67000000`
    const reply = `0x${[3_000_000n, 0n, 4n].map((value) => value.toString(16).padStart(64, '0')).join('')}`
    const rails = createRails(
      deps({
        rpcFor: () => async () => reply,
        allowances: async () => [
          { chain: 'base', delegationHash: `0x${'ab'.repeat(32)}`, terms, expiresAt: '2026-10-19T00:00:00Z' },
        ],
      }),
    )
    expect(await rails.allowances()).toMatchObject([
      { layer: 'onchain', period: 'hour', limit: '5', used: '2', remaining: '3', chain: 'base' },
    ])
  })
})

const delegated = () => async () => '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b'

describe('upgrade', () => {
  const request = {
    chain: 'base',
    authorization: {
      address: '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B',
      chainId: 8453,
      nonce: 0,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
      yParity: 0,
    },
  } as const

  test('reports the relay result as an operation with a verifiable terms hash', async () => {
    let landed = false
    const relay = {
      upgrade: async () => {
        landed = true
        return { txHash: toHex(`0x${'cd'.repeat(32)}`), status: 'success' as const, nonce: 3 }
      },
    }
    // The owner's code delegates to the DeleGator only once the relayed upgrade has landed.
    const rpcFor = () => async () => (landed ? delegated()() : word(10_000_000n))
    const operationResult = await createRails(deps({ relay, rpcFor })).upgrade(request)
    expect(operationResult).toMatchObject({
      status: 'confirmed',
      terms: { kind: 'upgrade', rail: 'relay' },
      payment: { txHash: `0x${'cd'.repeat(32)}` },
    })
    expect(operationResult.termsHash).toBe(await termsHash(operationResult.terms))
  })

  test('an owner already delegated to the DeleGator is confirmed without relaying again', async () => {
    const relay = { upgrade: vi.fn() }
    const operationResult = await createRails(deps({ relay, rpcFor: delegated })).upgrade(request)
    expect(operationResult.status).toBe('confirmed')
    expect(relay.upgrade).not.toHaveBeenCalled()
  })

  test('a relay failure is a failed operation; no relay is an error', async () => {
    const relay = { upgrade: () => Promise.reject(new Error('rpc down')) }
    expect((await createRails(deps({ relay })).upgrade(request)).status).toBe('failed')
    await expect(createRails(deps()).upgrade(request)).rejects.toThrow(/No relay/u)
  })
})
