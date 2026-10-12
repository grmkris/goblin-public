import { field, JsonRpcError, type JsonRpc } from '@goblin/wallet/balances'
import { fakeBundler, fakeNode, localAgent, TEST_TX, TEST_USEROP_HASH } from '@goblin/wallet/bundler/testing'
import { BASE } from '@goblin/wallet/chains'
import type { AgentSigner, Operation, ServiceRule, Terms, UserOperation } from '@goblin/wallet/contract'
import { DEFAULT_SERVICES, termsHash } from '@goblin/wallet/contract'
import { approvePaymaster, executeBatch } from '@goblin/wallet/userop'
import { describe, expect, test } from 'vitest'
import type { PendingUpgrade } from '../services/rails.ts'
import { FUNDS_SHORT } from './challenge.ts'
import { TOP_UP_SETTLE_MS } from './fetch.ts'
import { createRails, type RailsDeps } from './index.ts'
import { decodePendingUpgrade, encodePendingUpgrade } from './upgrade.ts'

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
    signUserOperation: async ({ userOp }) => {
      sent.push(userOp.sender)
      return `0x${'22'.repeat(65)}`
    },
  }
}

/** Rails whose agent really signs UserOperations, against a fake node and Pimlico. */
const agentDeps = (usdc: () => bigint, bundler = fakeBundler(), overrides: Partial<RailsDeps> = {}) =>
  deps({ signer: localAgent(), rpcFor: () => fakeNode({ usdc }), bundlerFor: () => bundler.rpc, ...overrides })

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
    const unknown = await refused.payPaidFetch(operation(terms), EXA, {})
    expect(unknown).toMatchObject({ outcome: 'uncertain', payment: { rail: 'x402', authorization: { from: AGENT } } })
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
    const bundler = fakeBundler()
    const rails = createRails(
      agentDeps(() => (bundler.batches.length > 0 ? 10_000_000n : 0n), bundler, {
        topUp: async () => ({ redeemCalldata: () => '0xfeed', available: async () => 20_000_000n }),
        wait: { attempts: 2, sleep: async (ms) => void slept.push(ms) },
        fetchFn: exaFetch(),
      }),
    )
    const terms = await rails.quotePaidFetch(EXA, {}, 'x402')
    expect(await rails.payPaidFetch(operation(terms), EXA, {})).toMatchObject({ outcome: 'settled' })
    expect(bundler.batches).toHaveLength(1)
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

describe('pay challenge', () => {
  test('refuses before signing when the agent holds too little USDC.e on Tempo; an unread balance never blocks', async () => {
    const terms = await createRails(deps({ fetchFn: exaFetch() })).quotePaidFetch(EXA, { query: 'goblin' }, 'mpp')
    const empty = createRails(deps({ rpcFor: () => async () => word(0n) }))
    expect(await empty.payChallenge(operation(terms), mppHeader(), 'abc')).toEqual({
      outcome: 'failed',
      reason: `${FUNDS_SHORT} 0 USDC.e on Tempo; this payment needs 0.007. Send USDC.e on Tempo to ${AGENT}, or add funds from any chain (add_funds).`,
    })
    const unread = createRails(deps({ rpcFor: () => () => Promise.reject(new Error('Tempo is down')) }))
    // The test signer cannot sign on Tempo, so getting this far means the funds check let it through.
    expect(await unread.payChallenge(operation(terms), mppHeader(), 'abc')).toMatchObject({
      reason: 'The agent wallet cannot sign on Tempo yet.',
    })
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

  test('pays from the agent balance in one UserOperation, or reports why it cannot', async () => {
    const rails = createRails(agentDeps(() => 5_000_000n))
    const terms = await rails.quoteTransfer(input)
    const outcome = await rails.transfer(operation(terms))
    expect(outcome).toMatchObject({
      outcome: 'settled',
      payment: {
        rail: 'transfer',
        userOpHash: TEST_USEROP_HASH,
        txHash: TEST_TX,
        explorerUrl: expect.stringContaining('basescan.org/tx/'),
      },
    })
    const broke = await createRails(agentDeps(() => 0n)).transfer(operation(terms))
    expect(broke).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('holds') })
  })

  test('a transfer not mined in time is uncertain and keeps its UserOperation for a later check', async () => {
    const rails = createRails(agentDeps(() => 5_000_000n, fakeBundler({ receipt: 'none' })))
    const outcome = await rails.transfer(operation(await rails.quoteTransfer(input)))
    expect(outcome).toMatchObject({ outcome: 'uncertain', payment: { rail: 'transfer', userOpHash: TEST_USEROP_HASH } })
    expect(outcome.outcome === 'uncertain' && outcome.payment?.settledAt).toBeFalsy()
  })

  test('a signer that will not sign has sent nothing; a bundler that never answers the send may have', async () => {
    const refusing = { ...localAgent(), signUserOperation: () => Promise.reject(new Error('policy')) }
    const rails = createRails(agentDeps(() => 5_000_000n, fakeBundler(), { signer: refusing }))
    expect((await rails.transfer(operation(await rails.quoteTransfer(input)))).outcome).toBe('failed')
    const silent = fakeBundler()
    const dropping: JsonRpc = (method, params) =>
      method === 'eth_sendUserOperation'
        ? Promise.reject(new JsonRpcError(method, 'HTTP 504'))
        : silent.rpc(method, params)
    const lost = createRails(agentDeps(() => 5_000_000n, { ...silent, rpc: dropping }))
    expect((await lost.transfer(operation(await lost.quoteTransfer(input)))).outcome).toBe('uncertain')
  })
})

describe('balances and allowances', () => {
  test('lists gas and USDC for the agent and the owner', async () => {
    const rails = createRails(deps({ rpcFor: () => async () => word(1_000_000n) }))
    const { balances: rows, unread } = await rails.balances()
    expect(unread).toEqual([])
    expect(
      rows.filter((row) => row.chain === 'base').map((row) => `${row.holder}:${row.symbol}:${row.balance}`),
    ).toEqual(['agent:ETH:0.000000000001', 'agent:USDC:1', 'owner:ETH:0.000000000001', 'owner:USDC:1'])
    expect(rows.find((row) => row.chain === 'tempo')?.symbol).toBe('USDC.e')
  })

  test('a chain whose RPC fails is unread, with no zero rows of its own', async () => {
    const rails = createRails(
      deps({
        rpcFor: (chain) => async () => {
          if (chain === 'arbitrum') throw new Error('rate limited')
          return word(1_000_000n)
        },
      }),
    )
    const { balances: rows, unread } = await rails.balances()
    expect(unread).toEqual(['arbitrum'])
    expect(rows.some((row) => row.chain === 'arbitrum')).toBe(false)
    expect(rows.some((row) => row.chain === 'base')).toBe(true)
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

const UPGRADER = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const AA = BASE.aa ?? failTest()
const DESIGNATOR = `0xef0100${BASE.delegation.delegator.slice(2).toLowerCase()}`
const USEROP_HASH = `0x${'ab'.repeat(32)}`
const BUNDLE_TX = `0x${'cd'.repeat(32)}`
/** UPGRADER's (key 0x11…11) authorization of the DeleGator on Base at nonce 0, signed once with viem. */
const AUTHORIZATION = {
  address: BASE.delegation.delegator,
  chainId: BASE.id,
  nonce: 0,
  r: '0x628ed423023a2c1e7d55bc730d8cc0bdd89dc31059a6153f79dfda37627d333c',
  s: '0x0419cfd3d73e5decfaecb6e1e7c6ec4a673a0f4f34275251ef53b2dc5a45d094',
  yParity: 1,
}
/** An upgrade operation as the bundler prepared it, and UPGRADER's signature over its DeleGator typed data. */
const UPGRADE_OP: UserOperation = {
  sender: UPGRADER,
  nonce: 0n,
  callData: executeBatch([approvePaymaster(BASE, AA.paymaster, 16_319n)]),
  callGasLimit: 275_767n,
  verificationGasLimit: 61_585n,
  preVerificationGas: 104_329n,
  maxFeePerGas: 8_855_000n,
  maxPriorityFeePerGas: 1_265_000n,
  paymaster: AA.paymaster,
  paymasterVerificationGasLimit: 46_456n,
  paymasterPostOpGasLimit: 43_715n,
  paymasterData: '0x0200',
  signature: '0x',
}
const OP_SIGNATURE =
  '0x5b6d1682a2b0b16768f2dcd65b1d6fb7f0e2177a84dd931d3d2ee9d47aecadfb534153d88fae6aa64c38ea99e7984c0e6dc346a9390ee082ee621e2854ec16f61c'
const hexOf = (value: bigint) => `0x${value.toString(16)}`

/** Base as the upgrade sees it: the owner's nonce and USDC, and their code, the designator once `landed` (after `lag` reads). */
const upgradeChain =
  (state: { usdc: bigint; nonce: number; landed: boolean; lag: number }): JsonRpc =>
  async (method, params) => {
    if (method === 'eth_getTransactionCount') return hexOf(BigInt(state.nonce))
    if (method === 'eth_getCode') return state.landed && (state.lag -= 1) < 0 ? DESIGNATOR : '0x'
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
    const to = String(field(params[0], 'to'))
    return word(to.toLowerCase() === AA.entryPoint.toLowerCase() ? 0n : state.usdc)
  }

/** Pimlico on Base: a USDC quote, gas prices and estimates, paymaster data; a sent operation lands with `receipt`. */
const pimlico = (onSend: () => void, receipt: unknown = { success: true, receipt: { transactionHash: BUNDLE_TX } }) => {
  const calls: { method: string; params: readonly unknown[] }[] = []
  const answers: Record<string, unknown> = {
    pimlico_getTokenQuotes: {
      quotes: [{ paymaster: AA.paymaster, exchangeRate: hexOf(2_788_189_200n), postOpGas: hexOf(18_990n) }],
    },
    pimlico_getUserOperationGasPrice: {
      fast: { maxFeePerGas: hexOf(8_855_000n), maxPriorityFeePerGas: hexOf(1_265_000n) },
    },
    pm_getPaymasterStubData: {
      paymaster: AA.paymaster,
      paymasterData: '0x0300',
      paymasterPostOpGasLimit: hexOf(68_990n),
    },
    eth_estimateUserOperationGas: {
      callGasLimit: hexOf(275_767n),
      verificationGasLimit: hexOf(61_585n),
      preVerificationGas: hexOf(104_329n),
      paymasterVerificationGasLimit: hexOf(46_456n),
      paymasterPostOpGasLimit: hexOf(43_715n),
    },
    pm_getPaymasterData: { paymaster: AA.paymaster, paymasterData: '0x0200' },
    eth_sendUserOperation: USEROP_HASH,
    eth_getUserOperationReceipt: receipt,
  }
  const rpc: JsonRpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'eth_sendUserOperation') onSend()
    if (!(method in answers)) throw new Error(`unexpected ${method}`)
    return answers[method]
  }
  return { rpc, calls }
}

/** The owner UPGRADER on Base, with `usdc` units and nonce 0; the operation lands with the delegation unless `applied` is false. */
const upgradeSetup = (
  options: { usdc?: bigint; nonce?: number; landed?: boolean; applied?: boolean; receipt?: unknown } = {},
) => {
  const state = {
    usdc: options.usdc ?? 1_000_000n,
    nonce: options.nonce ?? 0,
    landed: options.landed ?? false,
    lag: options.landed === true ? 0 : 1,
  }
  const bundler = pimlico(() => {
    state.landed = options.applied ?? true
  }, options.receipt)
  const rails = createRails(
    deps({
      profile: async () => ({ ownerAddress: UPGRADER, agentAddress: AGENT, chains: [] }),
      rpcFor: () => upgradeChain(state),
      bundlerFor: () => bundler.rpc,
    }),
  )
  return { rails, bundler, sent: () => bundler.calls.some((call) => call.method === 'eth_sendUserOperation') }
}

const prepare = (setup: ReturnType<typeof upgradeSetup>, authorization = AUTHORIZATION) =>
  setup.rails.prepareUpgrade({ chain: 'base', authorization })

const pendingOf = (op: UserOperation = UPGRADE_OP): PendingUpgrade => ({
  upgradeId: 'upgrade:base:6f1c2c4e-8b1a-4d0e-9f3a-2b7c5d9e1a40',
  chain: 'base',
  prepared: { op, authorization: AUTHORIZATION, entryPoint: AA.entryPoint, feeBound: 16_319n },
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
})

describe('upgrade', () => {
  test("prepares a UserOperation from the owner's own address that carries their authorization; their USDC pays its gas", async () => {
    const { rails, bundler } = upgradeSetup()
    const prepared = await rails.prepareUpgrade({ chain: 'base', authorization: AUTHORIZATION })
    if (prepared.kind !== 'draft') throw new Error('expected an operation to sign')
    expect(prepared.maxFeeUsdc).toBe('0.016319')
    expect(prepared.pending).toMatchObject({ chain: 'base', expiresAt: '2026-10-12T06:05:00.000Z' })
    expect(prepared.pending.prepared.op).toMatchObject({ sender: UPGRADER, nonce: 0n, paymaster: AA.paymaster })
    expect(prepared.typedData).toMatchObject({
      domain: { name: 'EIP7702StatelessDeleGator', chainId: BASE.id, verifyingContract: UPGRADER },
      message: { sender: UPGRADER, nonce: '0', entryPoint: AA.entryPoint },
    })
    const estimate = bundler.calls.find((call) => call.method === 'eth_estimateUserOperationGas')
    expect(estimate?.params[0]).toMatchObject({ sender: UPGRADER, eip7702Auth: { address: BASE.delegation.delegator } })
    // The ledger keeps it as JSON and gets back exactly what was prepared.
    expect(decodePendingUpgrade(encodePendingUpgrade(prepared.pending))).toEqual(prepared.pending)
  })

  test('refuses testnets, an authorization for another chain or from someone else, a stale nonce and too little USDC', async () => {
    const testnet = createRails(deps({ live: false }))
    await expect(testnet.prepareUpgrade({ chain: 'base', authorization: AUTHORIZATION })).rejects.toMatchObject({
      code: 'mainnet_only',
    })
    await expect(prepare(upgradeSetup(), { ...AUTHORIZATION, chainId: 1 })).rejects.toMatchObject({
      code: 'bad_authorization',
    })
    await expect(prepare(upgradeSetup(), { ...AUTHORIZATION, nonce: 1 })).rejects.toMatchObject({
      code: 'bad_authorization',
    })
    await expect(prepare(upgradeSetup({ nonce: 1 }))).rejects.toMatchObject({ code: 'stale_authorization' })
    const poor = upgradeSetup({ usdc: 16_318n })
    await expect(prepare(poor)).rejects.toMatchObject({
      code: 'insufficient_funds',
      message: expect.stringContaining('up to 0.016319 USDC'),
    })
    expect(poor.sent()).toBe(false)
    const empty = upgradeSetup({ usdc: 0n })
    await expect(prepare(empty)).rejects.toMatchObject({ code: 'insufficient_funds' })
    expect(empty.bundler.calls).toEqual([])
    await expect(
      createRails(deps()).prepareUpgrade({ chain: 'base', authorization: AUTHORIZATION }),
    ).rejects.toMatchObject({ code: 'not_configured' })
  })

  test('an account that already delegates to the DeleGator is confirmed with nothing to sign or send', async () => {
    const { rails, bundler } = upgradeSetup({ landed: true })
    const prepared = await rails.prepareUpgrade({ chain: 'base', authorization: AUTHORIZATION })
    expect(prepared).toMatchObject({ kind: 'upgraded', operation: { status: 'confirmed', terms: { kind: 'upgrade' } } })
    expect(bundler.calls).toEqual([])
  })

  test("sends the signed operation and is confirmed once the owner's code delegates, read from a node a block behind", async () => {
    const { rails } = upgradeSetup()
    const confirmed = await rails.confirmUpgrade(pendingOf(), OP_SIGNATURE)
    expect(confirmed).toMatchObject({
      id: 'upgrade:base:6f1c2c4e-8b1a-4d0e-9f3a-2b7c5d9e1a40',
      status: 'confirmed',
      terms: { kind: 'upgrade', rail: 'userop', amount: '0.016319', recipient: AA.paymaster },
      payment: { rail: 'userop', userOpHash: USEROP_HASH, txHash: BUNDLE_TX },
    })
    expect(confirmed.termsHash).toBe(await termsHash(confirmed.terms))
  })

  test("a signature that is not the owner's fails before anything is sent; in flight is submitted; skipped is failed", async () => {
    const forged = upgradeSetup()
    const failed = await forged.rails.confirmUpgrade(pendingOf({ ...UPGRADE_OP, nonce: 1n }), OP_SIGNATURE)
    expect(failed).toMatchObject({ status: 'failed', reason: expect.stringContaining('not from the sending account') })
    expect(forged.sent()).toBe(false)
    const slow = upgradeSetup({ receipt: null, applied: false })
    expect(await slow.rails.confirmUpgrade(pendingOf(), OP_SIGNATURE)).toMatchObject({
      status: 'submitted',
      payment: { userOpHash: USEROP_HASH },
    })
    const skipped = upgradeSetup({ applied: false })
    expect(await skipped.rails.confirmUpgrade(pendingOf(), OP_SIGNATURE)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('did not apply'),
    })
  })
})

describe('check', () => {
  const HASH = `0x${'ef'.repeat(32)}`
  const uncertainOp = (kind: Terms['kind'], payment: Operation['payment']): Operation => ({
    ...operation({
      kind,
      chain: 'base',
      rail: kind === 'paid_fetch' ? 'x402' : 'transfer',
      subject: 'check',
      token: { symbol: 'USDC', address: BASE_USDC, decimals: 6 },
      amount: '0.007',
      amountUsd: '0.007',
      recipient: PAY_TO,
      expiresAt: NOW.toISOString(),
    }),
    status: 'uncertain',
    ...(payment === undefined ? {} : { payment }),
  })
  const authorization = (validBefore: Date) => ({
    from: AGENT,
    nonce: `0x${'cd'.repeat(32)}`,
    validBefore: String(Math.floor(validBefore.getTime() / 1000)),
  })
  const node =
    (answer: { receipt?: unknown; used?: boolean }): JsonRpc =>
    async (method) =>
      method === 'eth_getTransactionReceipt' ? (answer.receipt ?? null) : word(answer.used === true ? 1n : 0n)
  const checked = (rpc: JsonRpc, op: Operation) => createRails(deps({ rpcFor: () => rpc })).check(op)

  test('a sent transaction: mined is paid, reverted is not, missing is not known yet', async () => {
    const sent = uncertainOp('transfer', { rail: 'transfer', txHash: HASH })
    expect(await checked(node({ receipt: { status: '0x1' } }), sent)).toMatchObject({
      found: 'paid',
      delivered: true,
      payment: { rail: 'transfer', txHash: HASH, settledAt: NOW.toISOString() },
    })
    expect(await checked(node({ receipt: { status: '0x0' } }), sent)).toMatchObject({ found: 'not_paid' })
    expect(await checked(node({}), sent)).toMatchObject({ found: 'unknown' })
  })

  test('an x402 authorization: used is paid, unused past its deadline is not, unused before it could still be', async () => {
    const later = uncertainOp('paid_fetch', {
      rail: 'x402',
      authorization: authorization(new Date(NOW.getTime() + 60_000)),
    })
    const lapsed = uncertainOp('paid_fetch', {
      rail: 'x402',
      authorization: authorization(new Date(NOW.getTime() - 60_000)),
    })
    expect(await checked(node({ used: true }), later)).toMatchObject({
      found: 'paid',
      delivered: false,
      payment: { rail: 'x402', settledAt: NOW.toISOString() },
    })
    expect(await checked(node({ used: false }), lapsed)).toMatchObject({ found: 'not_paid' })
    expect(await checked(node({ used: false }), later)).toMatchObject({
      found: 'unknown',
      reason: expect.stringContaining('could still settle'),
    })
  })

  test("a UserOperation: the bundler's receipt decides, since the bundle's own transaction succeeds either way", async () => {
    const sent = uncertainOp('transfer', { rail: 'transfer', userOpHash: TEST_USEROP_HASH })
    const ask = (receipt: 'success' | 'reverted' | 'none') =>
      createRails(deps({ bundlerFor: () => fakeBundler({ receipt }).rpc })).check(sent)
    expect(await ask('success')).toMatchObject({
      found: 'paid',
      payment: { userOpHash: TEST_USEROP_HASH, txHash: TEST_TX },
    })
    expect(await ask('reverted')).toMatchObject({ found: 'not_paid' })
    expect(await ask('none')).toMatchObject({ found: 'unknown' })
  })

  test('nothing recorded to ask about is not known', async () => {
    expect(await checked(node({}), uncertainOp('paid_fetch', undefined))).toMatchObject({ found: 'unknown' })
  })
})
