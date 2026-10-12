import { field, type JsonRpc } from '@goblin/wallet/balances'
import { RELAY_DEPOSITORY } from '@goblin/wallet/bridge'
import { fakeBundler, fakeNode, localAgent, TEST_TX, TEST_USEROP_HASH } from '@goblin/wallet/bundler/testing'
import { BASE, TEMPO } from '@goblin/wallet/chains'
import type { Operation } from '@goblin/wallet/contract'
import { approvePaymaster } from '@goblin/wallet/userop'
import { describe, expect, test } from 'vitest'
import { LedgerObject, ledgerClient } from '../ledger/durable.ts'
import { alarmHost, T0 } from '../ledger/fixtures.ts'
import type { PayOutcome } from '../services/rails.ts'
import { FUNDS_SHORT, payChallenge } from './challenge.ts'
import type { FloatSchedule, RailsDeps } from './deps.ts'
import {
  afterPayment,
  type FloatIo,
  type FloatReading,
  REFILLING,
  refillForShort,
  runFloat,
  sendRefill,
} from './float.ts'

const OWNER = '0x1111111111111111111111111111111111111111'
const AGENT = '0x4444444444444444444444444444444444444444'
const usdc = (dollars: number): bigint => BigInt(Math.round(dollars * 1_000_000))
const unused = (): never => {
  throw new Error('not used')
}

const reading = (overrides: Partial<FloatReading> = {}): FloatReading => ({
  agent: AGENT,
  held: 0n,
  allowance: usdc(20),
  owner: usdc(50),
  agentBase: 0n,
  ...overrides,
})

const baseDeps = (overrides: Partial<RailsDeps> = {}): RailsDeps => ({
  live: true,
  signer: undefined,
  profile: async () => ({ ownerAddress: OWNER, agentAddress: AGENT, chains: [] }),
  rpcFor: unused,
  now: () => new Date(T0),
  ...overrides,
})

/** A ledger Durable Object on a test clock, a run's I/O that records what it sent, and the outcome it answers. */
const harness = (
  answer: PayOutcome = { outcome: 'settled', payment: { rail: 'relay' }, delivery: { status: 'delivered' } },
) => {
  const clock = { now: T0 }
  const ledger = ledgerClient(new LedgerObject(alarmHost(), () => clock.now))
  const sent: Operation[] = []
  const state: { reading: FloatReading | { unsourced: 'no_allowance' }; answer: PayOutcome; release: Promise<void> } = {
    reading: reading(),
    answer,
    release: Promise.resolve(),
  }
  const io: FloatIo = {
    read: async () => state.reading,
    send: async (_deps, operation, onSubmitted) => {
      sent.push(operation)
      await onSubmitted(TEST_USEROP_HASH)
      await state.release
      return state.answer
    },
    delivery: async () => 'delivered',
  }
  return { clock, ledger, sent, state, io, run: (deps = baseDeps()) => runFloat(deps, ledger, io) }
}

describe('a float run', () => {
  test('on testnets it reads, claims and sends nothing', async () => {
    const h = harness()
    const io = { ...h.io, read: unused }
    expect(await runFloat(baseDeps({ live: false }), h.ledger, io)).toEqual({})
    expect(await h.ledger.activity()).toEqual([])
  })

  test('an empty float is refilled to $3 and the move is in the activity, delivered', async () => {
    const h = harness()
    expect(await h.run()).toEqual({})
    expect(h.sent.map((operation) => operation.terms.amount)).toEqual(['3'])
    const [move] = await h.ledger.activity()
    expect(move).toMatchObject({
      id: expect.stringMatching(/^float:/u),
      status: 'delivered',
      terms: { kind: 'bridge', chain: 'base', rail: 'relay', recipient: AGENT },
      payment: { rail: 'relay' },
    })
    expect(move?.terms.subject).toBe('Moved $3.00 to Tempo for paid inference')
    expect((await h.ledger.floatState()).refilling).toBe(false)
  })

  test('a full float, or one nothing on Base can refill, moves nothing', async () => {
    const h = harness()
    h.state.reading = reading({ held: usdc(1.5) })
    expect(await h.run()).toEqual({})
    h.state.reading = { unsourced: 'no_allowance' }
    expect(await h.run()).toEqual({})
    h.state.reading = reading({ allowance: usdc(0.3) })
    expect(await h.run()).toEqual({})
    expect(h.sent).toEqual([])
  })

  test('two triggers at once send one refill; the second finds it in flight', async () => {
    const h = harness()
    const gate: { open?: () => void } = {}
    h.state.release = new Promise<void>((resolve) => {
      gate.open = resolve
    })
    const first = h.run()
    const second = h.run()
    expect(await second).toEqual({})
    expect((await h.ledger.floatState()).refilling).toBe(true)
    gate.open?.()
    expect(await first).toEqual({})
    expect(h.sent).toHaveLength(1)
  })

  test('a payment that must fit sizes the refill', async () => {
    const h = harness()
    h.state.reading = reading({ held: usdc(2) })
    await h.ledger.scheduleFloat({ delayMs: 0, need: '4.5' })
    await h.run()
    expect(h.sent.map((operation) => operation.terms.amount)).toEqual(['2.5'])
  })

  test('a failed refill is recorded and run again later; a chain that did not answer too, with nothing recorded', async () => {
    const h = harness({ outcome: 'failed', reason: 'Relay answered 503.' })
    expect(await h.run()).toEqual({ retryInMs: 60_000 })
    expect(await h.ledger.activity()).toEqual([
      expect.objectContaining({ status: 'failed', reason: 'Relay answered 503.' }),
    ])
    const down = harness()
    const io = { ...down.io, read: () => Promise.reject(new Error('rpc down')) }
    expect(await runFloat(baseDeps(), down.ledger, io)).toEqual({ retryInMs: 60_000 })
    expect(await down.ledger.activity()).toEqual([])
  })

  test('an unknown outcome keeps its UserOperation and holds the flight; the next run sends nothing', async () => {
    const h = harness({ outcome: 'uncertain', reason: 'The refill was sent but has not confirmed yet.' })
    await h.run()
    const [move] = await h.ledger.activity()
    expect(move).toMatchObject({ status: 'uncertain', payment: { userOpHash: TEST_USEROP_HASH } })
    await h.run()
    expect(h.sent).toHaveLength(1)
  })

  test('a deposit whose arrival Relay had not reported is asked about once more; arrived, it frees the flight', async () => {
    const h = harness({
      outcome: 'settled',
      payment: { rail: 'relay', reference: 'relay:0x12' },
      delivery: { status: 'pending', detail: 'Relay: waiting' },
    })
    await h.run()
    expect((await h.ledger.activity())[0]?.status).toBe('confirmed')
    expect((await h.ledger.floatState()).refilling).toBe(true)
    h.state.reading = reading({ held: usdc(2.98) })
    await h.run()
    expect(await h.ledger.activity()).toEqual([
      expect.objectContaining({ status: 'delivered', delivery: { status: 'delivered', detail: 'Relay: success' } }),
    ])
    expect(h.sent).toHaveLength(1)
  })
})

/** Hooks that record what a trigger asked the ledger for. */
const hooks = (state: { refilling: boolean; pausedUntil?: string } = { refilling: false }) => {
  const asked: FloatSchedule[] = []
  return {
    asked,
    float: {
      state: async () => state,
      schedule: async (request: FloatSchedule) => {
        asked.push(request)
      },
    },
  }
}

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`

/** A node per chain that answers `balanceOf` by holder: the agent's USDC.e on Tempo, the owner's and agent's on Base. */
const balances =
  (tempo: bigint, owner: bigint, agentBase = 0n) =>
  (chain: string) => {
    const rpc: JsonRpc = async (_method, params) => {
      const holder = `0x${String(field(params[0], 'data')).slice(-40)}`.toLowerCase()
      if (chain === 'tempo') return word(tempo)
      return word(holder === OWNER ? owner : agentBase)
    }
    return rpc
  }

const sourced = (overrides: Partial<RailsDeps> = {}): RailsDeps =>
  baseDeps({
    rpcFor: balances(0n, usdc(50)),
    allowances: async () => [{ chain: 'base', delegationHash: '0xdd', terms: '0x', expiresAt: '2026-10-19T10:00:00Z' }],
    topUp: async () => ({ redeemCalldata: () => '0xfeed', available: async () => usdc(20) }),
    ...overrides,
  })

const expiredAllowance = async () => [
  { chain: 'base' as const, delegationHash: '0xdd', terms: '0x', expiresAt: '2026-10-01T00:00:00Z' },
]

/** A refill operation as a run hands it to `sendRefill`: only its id and amount are read. */
const refillOperation = (id: string): Operation => ({
  id,
  status: 'signing',
  terms: {
    kind: 'bridge',
    chain: 'base',
    rail: 'relay',
    subject: 'Moved $2.00 to Tempo for paid inference',
    token: { symbol: 'USDC', address: BASE.usdc.address, decimals: 6 },
    amount: '2',
    amountUsd: '2',
    recipient: AGENT,
    expiresAt: '2026-10-12T10:10:00Z',
  },
  termsHash: '0xab',
  limitsVersion: 1,
  createdAt: '2026-10-12T10:00:00Z',
  updatedAt: '2026-10-12T10:00:00Z',
})

describe('the triggers', () => {
  test('a payment that leaves the float under $1 asks for a check 30 s later, once the service redeemed it', async () => {
    const h = hooks()
    await afterPayment(baseDeps({ float: h.float }), usdc(1.02), usdc(0.05))
    await afterPayment(baseDeps({ float: h.float }), usdc(2), usdc(0.05))
    await afterPayment(baseDeps({ float: h.float }), undefined, usdc(0.05))
    await afterPayment(baseDeps({ float: h.float, live: false }), 0n, usdc(0.05))
    expect(h.asked).toEqual([{ delayMs: 30_000 }])
  })

  test('a charge refused for funds starts a refill when Base can release one, carrying the charge', async () => {
    const h = hooks()
    expect(await refillForShort(sourced({ float: h.float }), usdc(0.02))).toBe(true)
    expect(h.asked).toEqual([{ delayMs: 0, need: '0.02' }])
  })

  test('a refill in flight answers yes without reading; paused, testnet or nothing to draw on answers no', async () => {
    const flying = hooks({ refilling: true })
    expect(await refillForShort(baseDeps({ float: flying.float }), usdc(0.02))).toBe(true)
    expect(flying.asked).toHaveLength(1)
    const paused = hooks({ refilling: false, pausedUntil: '2026-10-12T11:00:00Z' })
    expect(await refillForShort(sourced({ float: paused.float }), usdc(0.02))).toBe(false)
    const quiet = hooks()
    expect(await refillForShort(sourced({ float: quiet.float, live: false }), usdc(0.02))).toBe(false)
    expect(await refillForShort(sourced({ float: quiet.float, rpcFor: balances(0n, usdc(0.2)) }), 1n)).toBe(false)
    expect(await refillForShort(sourced({ float: quiet.float, allowances: expiredAllowance }), 1n)).toBe(false)
    expect(
      await refillForShort(sourced({ float: quiet.float, profile: () => Promise.reject(new Error('x')) }), 1n),
    ).toBe(false)
    expect(quiet.asked).toEqual([])
  })

  test('pay_challenge short of USDC.e says a refill is coming when one starts, and where to send it when none can', async () => {
    const operation: Operation = {
      id: 'inference:abc',
      status: 'signing',
      terms: {
        kind: 'paid_fetch',
        chain: 'tempo',
        rail: 'mpp',
        subject: 'goblin.surf',
        token: { symbol: 'USDC.e', address: TEMPO.usdc.address, decimals: 6 },
        amount: '0.02',
        amountUsd: '0.02',
        recipient: OWNER,
        expiresAt: '2026-10-12T10:05:00Z',
      },
      termsHash: '0xab',
      limitsVersion: 1,
      createdAt: '2026-10-12T10:00:00Z',
      updatedAt: '2026-10-12T10:00:00Z',
    }
    const h = hooks()
    const refilling = await payChallenge(operation, 'x', 'abc', sourced({ signer: localAgent(), float: h.float }))
    expect(refilling).toEqual({ outcome: 'failed', reason: REFILLING })
    expect(h.asked).toEqual([{ delayMs: 0, need: '0.02' }])
    const none = await payChallenge(
      operation,
      'x',
      'abc',
      sourced({ signer: localAgent(), allowances: async () => [] }),
    )
    expect(none).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(new RegExp(`^${FUNDS_SHORT}`, 'u')) })
  })
})

const pad = (hex: string) => hex.replace(/^0x/u, '').toLowerCase().padStart(64, '0')
/** `depositErc20(address depositor, address token, uint256 amount, bytes32 id)`, encoded by hand (selector 0xe8017952). */
const depositCall = (depositor: string, amount: bigint) =>
  `0xe8017952${pad(depositor)}${pad(BASE.usdc.address)}${pad(amount.toString(16))}${'12'.repeat(32)}`

/** Relay as a refill sees it: a quote of `amount` Base USDC to `agent` on Tempo, then the fill's status. */
const relay =
  (agent: string): typeof fetch =>
  async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.includes('/intents/status')) return Response.json({ status: 'success', txHashes: [TEST_TX] })
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
    const amount = BigInt(String(field(body, 'amount')))
    const step = (id: string, to: string, data: string) => ({
      id,
      kind: 'transaction',
      items: [{ data: { from: agent, to, chainId: BASE.id, value: '0', data } }],
    })
    const approve = approvePaymaster(BASE, RELAY_DEPOSITORY, amount).callData
    const deposit = depositCall(agent, amount)
    return Response.json({
      requestId: `0x${'34'.repeat(32)}`,
      steps: [step('approve', BASE.usdc.address, approve), step('deposit', RELAY_DEPOSITORY, deposit)],
      fees: { relayer: { amountUsd: '0.02' } },
      details: {
        recipient: agent,
        timeEstimate: 1,
        currencyIn: {
          currency: { address: BASE.usdc.address, chainId: BASE.id },
          amount: String(amount),
          amountUsd: '2',
        },
        currencyOut: {
          currency: { address: TEMPO.usdc.address, chainId: TEMPO.id },
          amount: String(amount - 20_000n),
          minimumAmount: String(amount - 40_000n),
        },
      },
    })
  }

describe('sending a refill', () => {
  test("one UserOperation redeems the deposit and its gas from the allowance; Relay's id is kept for the arrival", async () => {
    const agent = localAgent()
    const bundler = fakeBundler()
    const submitted: string[] = []
    const deps = baseDeps({
      signer: agent,
      rpcFor: () => fakeNode({ usdc: () => 0n }),
      bundlerFor: () => bundler.rpc,
      topUp: async () => ({ redeemCalldata: () => '0xfeed', available: async () => usdc(20) }),
      fetchFn: relay(agent.address),
      wait: { sleep: async () => undefined, attempts: 2 },
    })
    const operation = refillOperation('float:1:1')
    const outcome = await sendRefill(deps, operation, async (hash) => {
      submitted.push(hash)
    })
    expect(outcome).toMatchObject({
      outcome: 'settled',
      payment: {
        rail: 'relay',
        userOpHash: TEST_USEROP_HASH,
        txHash: TEST_TX,
        reference: `relay:0x${'34'.repeat(32)}`,
      },
      delivery: { status: 'delivered' },
    })
    expect(submitted).toEqual([TEST_USEROP_HASH])
    expect(bundler.batches[0]?.[0]).toEqual({ target: BASE.delegation.manager, value: 0n, callData: '0xfeed' })
  })

  test('no agent, or a Relay that refuses the quote, is failed with nothing sent', async () => {
    const operation = refillOperation('float:1:2')
    expect(await sendRefill(baseDeps(), operation, unused)).toMatchObject({ outcome: 'failed' })
    const refused = baseDeps({ signer: localAgent(), fetchFn: async () => new Response('no', { status: 503 }) })
    expect(await sendRefill(refused, operation, unused)).toEqual({ outcome: 'failed', reason: 'Relay answered 503.' })
  })
})
