import type { JsonRpc } from '@goblin/wallet/balances'
import { chainByKey } from '@goblin/wallet/chains'
import type { AgentSigner, Collection, MerchantSubscription, SubscriptionPayment } from '@goblin/wallet/contract'
import { prepareSubscription, type SubscriptionTerms } from '@goblin/wallet/delegation'
import { describe, expect, test } from 'vitest'
import { createApi } from '../api/index.ts'
import { defaultWiring } from '../context.ts'
import type { IdentityVerifier } from '../identity.ts'
import { LedgerObject } from '../ledger/durable.ts'
import { alarmHost } from '../ledger/fixtures.ts'
import { WalletAuth, authClient, subscriptionClient, type SubscriptionApi } from '../oauth/durable.ts'
import { testEnv } from '../test-env.ts'
import { type CollectDeps, collect } from './collect.ts'
import { GOBLIN_MERCHANT } from './config.ts'
import { createMerchantApi } from './routes.ts'
import type { SubscriptionRow } from './store.ts'

const DAY_S = 86_400
/** 2026-10-13T00:00:00Z: the UTC day the owner signs the day pass, at 09:30. */
const MIDNIGHT = Date.parse('2026-10-13T00:00:00.000Z') / 1000
const SIGNED_AT = MIDNIGHT + 9.5 * 3600
const OWNER = '0x1111111111111111111111111111111111111111'
const COLLECTOR = '0x2222222222222222222222222222222222222222'
const ID = `sub_${'da7e'.repeat(8)}`
const TX = `0x${'ab'.repeat(32)}`
const USER_OP = `0x${'cd'.repeat(32)}`
const DAY: SubscriptionTerms = { billing: 'day', amountUsd: '1.00', periodDays: 1, months: 12 }
const chain = chainByKey('base', false)

/** A day pass the owner signed at `SIGNED_AT`: its periods are UTC days from the midnight before. */
async function signedDayPass(): Promise<SubscriptionApi> {
  const store = subscriptionClient(new WalletAuth(alarmHost()))
  await store.createSubscription({
    id: ID,
    merchant: GOBLIN_MERCHANT,
    reference: 'user_1',
    billing: 'day',
    amountUsd: '1.00',
    periodDays: 1,
    months: 12,
    returnUrl: `https://goblin.surf/subscribe/success?subscription=${ID}`,
    collector: COLLECTOR,
    now: SIGNED_AT - 60,
  })
  await store.viewSubscription(ID, 'did:privy:owner', SIGNED_AT - 30)
  const prepared = prepareSubscription({ chain, owner: OWNER, collector: COLLECTOR, terms: DAY }, SIGNED_AT * 1000, 1n)
  const signed = {
    delegation: { ...prepared.delegation, signature: `0x${'ee'.repeat(65)}` },
    delegationHash: prepared.delegationHash,
    startsAt: prepared.startsAt,
    expiresAt: prepared.expiresAt,
  }
  expect(prepared.startsAt).toBe(new Date(MIDNIGHT * 1000).toISOString())
  await store.activate({
    id: ID,
    owner: 'did:privy:owner',
    ownerAddress: OWNER,
    signedJson: JSON.stringify(signed),
    delegationHash: prepared.delegationHash,
    startsAt: MIDNIGHT,
    expiresAt: MIDNIGHT + 365 * DAY_S,
    now: SIGNED_AT,
  })
  return store
}

const rowOf = async (store: SubscriptionApi): Promise<SubscriptionRow> =>
  (await store.subscription(ID)) ?? expect.fail('the subscription is kept')

const word = (value: bigint): string => value.toString(16).padStart(64, '0')

/** Base as the collector reads it: the delegation not disabled, the period's dollar unspent, the owner holding `held`. */
const base =
  (held: bigint): JsonRpc =>
  async (method, params) => {
    const [call] = params
    const to = typeof call === 'object' && call !== null && 'to' in call ? String(call.to).toLowerCase() : ''
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
    if (to === chain.delegation.manager.toLowerCase()) return `0x${word(0n)}`
    if (to === chain.delegation.enforcers.erc20PeriodTransfer.toLowerCase())
      return `0x${word(1_000_000n)}${word(1n)}${word(1n)}`
    if (to === chain.usdc.address.toLowerCase()) return `0x${word(held)}`
    throw new Error(`unexpected call to ${to}`)
  }

const untouched: JsonRpc = async (method) => {
  throw new Error(`no chain read expected, got ${method}`)
}

const refuse = (): Promise<never> => Promise.reject(new Error('the collector signs nothing in these tests'))
const collector: AgentSigner = {
  address: COLLECTOR,
  signTypedData: refuse,
  signUserOperation: refuse,
  signAuthorization: refuse,
}

const deps = (atS: number, overrides: Partial<CollectDeps> = {}): CollectDeps => ({
  live: false,
  rpc: untouched,
  bundler: untouched,
  collector,
  now: () => atS * 1000,
  ...overrides,
})

/** Period 1 paid at 10:00 on the day it was signed. */
const payDayOne = async (store: SubscriptionApi): Promise<void> => {
  await store.beginCollection({ subscriptionId: ID, period: 1, operationId: 'pro:user_1:1', now: SIGNED_AT + 1800 })
  await store.finishCollection({
    subscriptionId: ID,
    period: 1,
    status: 'paid',
    txHash: TX,
    userOpHash: USER_OP,
    now: SIGNED_AT + 1800,
  })
}

const post = (body: unknown): Request =>
  new Request('https://wallet.goblin.surf/api/merchant/subscriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer merchant-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('collecting a day pass', () => {
  test('a period already paid answers its payment, whatever the operation id, after it ends, revoked or expired', async () => {
    const store = await signedDayPass()
    await payDayOne(store)
    const paid: Collection = {
      status: 'paid',
      txHash: TX,
      userOpHash: USER_OP,
      paidAt: new Date((SIGNED_AT + 1800) * 1000).toISOString(),
    }
    const ask = async (atS: number, overrides: Partial<CollectDeps> = {}) =>
      collect(store, deps(atS, overrides), await rowOf(store), { period: 1, operationId: 'pro:user_1:retry' })
    expect(await ask(SIGNED_AT + 3600)).toEqual(paid)
    expect(await ask(MIDNIGHT + 3 * DAY_S)).toEqual(paid)
    await store.markRevoked(ID, MIDNIGHT + 3 * DAY_S)
    expect(await ask(MIDNIGHT + 4 * DAY_S)).toEqual(paid)
    expect(await ask(MIDNIGHT + 400 * DAY_S)).toEqual(paid)
    // Without the collector or a bundler, the answer is still the record's: nothing reads the chain.
    expect(await ask(MIDNIGHT + 2 * DAY_S, { collector: undefined, bundler: undefined })).toEqual(paid)
  })

  test('a day is due all through its UTC day, the next is not due yet, and one that ended unpaid has expired', async () => {
    const store = await signedDayPass()
    const row = await rowOf(store)
    const lastSecond = MIDNIGHT + DAY_S - 1
    expect(await collect(store, deps(lastSecond), row, { period: 2, operationId: 'pro:user_1:2' })).toEqual({
      status: 'failed',
      reason: 'not_due',
    })
    // Due: the collector reads the chain first, and an owner short of the dollar is refused before anything is signed.
    expect(
      await collect(store, deps(lastSecond, { rpc: base(400_000n) }), row, { period: 1, operationId: 'pro:user_1:1' }),
    ).toEqual({ status: 'failed', reason: 'insufficient_funds' })
    expect(await collect(store, deps(MIDNIGHT + DAY_S), row, { period: 1, operationId: 'pro:user_1:1' })).toEqual({
      status: 'failed',
      reason: 'expired',
    })
  })

  test('an attempt submitted just before midnight is settled by its receipt, not refused for the day ending', async () => {
    const store = await signedDayPass()
    const late = MIDNIGHT + DAY_S - 5
    await store.beginCollection({ subscriptionId: ID, period: 1, operationId: 'pro:user_1:1', now: late })
    await store.finishCollection({ subscriptionId: ID, period: 1, status: 'pending', userOpHash: USER_OP, now: late })
    const receipt: JsonRpc = async (method) =>
      method === 'eth_getUserOperationReceipt' ? { success: true, receipt: { transactionHash: TX } } : undefined
    const answer = await collect(store, deps(late + 60, { bundler: receipt }), await rowOf(store), {
      period: 1,
      operationId: 'pro:user_1:1',
    })
    expect(answer).toMatchObject({ status: 'paid', txHash: TX, userOpHash: USER_OP })
    expect((await rowOf(store)).paidPeriods).toBe(1)
  })
})

describe('the merchant API', () => {
  const env = testEnv({
    WALLET_MERCHANT_GOBLIN_KEY: 'merchant-key',
    MERCHANT_RETURN_ORIGINS: 'https://goblin.surf',
    COLLECTOR_WALLET_ID: 'collector-wallet',
    COLLECTOR_ADDRESS: COLLECTOR,
  })
  const request = {
    plan: 'pro',
    billing: 'day',
    amountUsd: '1.00',
    periodDays: 1,
    months: 12,
    reference: 'user_1',
    returnUrl: 'https://goblin.surf/subscribe/success',
  }

  test('asks a day pass of one-day periods only, and reads back its billing', async () => {
    const store = await signedDayPass()
    const handle = createMerchantApi({
      store: () => store,
      collector: async () => deps(SIGNED_AT),
      base: () => base(5_000_000n),
      now: () => SIGNED_AT * 1000,
    })
    expect((await handle(post({ ...request, periodDays: 30 }), env)).status).toBe(400)
    expect((await handle(post(request), env)).status).toBe(201)
    const read = await handle(
      new Request(`https://wallet.goblin.surf/api/merchant/subscriptions/${ID}`, {
        headers: { authorization: 'Bearer merchant-key' },
      }),
      env,
    )
    // SAFETY: the merchant route answers a MerchantSubscription; the test reads its fields.
    const view = (await read.json()) as MerchantSubscription
    expect(view).toMatchObject({
      billing: 'day',
      status: 'active',
      periodDays: 1,
      startsAt: '2026-10-13T00:00:00.000Z',
      expiresAt: '2027-10-13T00:00:00.000Z',
      shortUsd: '0',
    })
  })
})

describe("the owner's subscription payments", () => {
  const identity: IdentityVerifier = {
    verifyRequest: (request) =>
      Promise.resolve(
        request.headers.get('authorization') === 'Bearer owner'
          ? { ok: true, owner: { userId: 'did:privy:owner', ownerAddress: OWNER } }
          : { ok: true, owner: { userId: 'did:privy:stranger', ownerAddress: COLLECTOR } },
      ),
    verifyToken: () => Promise.resolve({ ok: false, reason: 'invalid_token' }),
  }

  test('list each paid period for its owner only, newest first, linked to its transaction', async () => {
    const store = await signedDayPass()
    await payDayOne(store)
    await store.beginCollection({
      subscriptionId: ID,
      period: 3,
      operationId: 'pro:user_1:3',
      now: MIDNIGHT + 2 * DAY_S,
    })
    await store.finishCollection({ subscriptionId: ID, period: 3, status: 'paid', now: MIDNIGHT + 2 * DAY_S + 30 })
    await store.beginCollection({
      subscriptionId: ID,
      period: 4,
      operationId: 'pro:user_1:4',
      now: MIDNIGHT + 3 * DAY_S,
    })
    await store.finishCollection({
      subscriptionId: ID,
      period: 4,
      status: 'failed',
      reason: 'insufficient_funds',
      now: MIDNIGHT + 3 * DAY_S,
    })
    const auth = authClient(new WalletAuth(alarmHost()))
    const api = createApi({
      identity: () => identity,
      auth: () => auth,
      wiring: { ...defaultWiring, ledger: () => new LedgerObject(alarmHost(), () => SIGNED_AT * 1000) },
      subscriptions: () => store,
    })
    const read = (token: string) =>
      api(
        new Request('https://wallet.test/api/subscription-payments', { headers: { authorization: `Bearer ${token}` } }),
        testEnv(),
      )
    const response = await read('owner')
    expect(response.status).toBe(200)
    // SAFETY: the route answers SubscriptionPayment[]; the test reads its fields.
    const payments = (await response.json()) as SubscriptionPayment[]
    expect(payments).toEqual([
      {
        id: `${ID}:3`,
        subscriptionId: ID,
        merchant: 'goblin',
        plan: 'pro',
        billing: 'day',
        amountUsd: '1.00',
        chain: 'base',
        period: 3,
        paidAt: new Date((MIDNIGHT + 2 * DAY_S + 30) * 1000).toISOString(),
      },
      {
        id: `${ID}:1`,
        subscriptionId: ID,
        merchant: 'goblin',
        plan: 'pro',
        billing: 'day',
        amountUsd: '1.00',
        chain: 'base',
        period: 1,
        paidAt: new Date((SIGNED_AT + 1800) * 1000).toISOString(),
        txHash: TX,
        explorerUrl: `${chain.explorerUrl}/tx/${TX}`,
      },
    ])
    expect(await (await read('stranger')).json()).toEqual([])
  })
})
