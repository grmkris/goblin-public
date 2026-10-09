import type { BillingState } from '@goblin/contracts'
import { AccountApi, BillingRefused } from '@goblin/contracts/api'
import { MutationObserver, skipToken } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { billingStateQuery, checkoutMutation, signedInBillingQuery } from '../src/account/queries.ts'
import { account } from '../src/lib/api.ts'
import { messageOf } from '../src/lib/query/app-error.ts'
import { fakeHttpApi, testQueryClient } from '../src/lib/query/testing.ts'

const LAPSED: BillingState = {
  active: false,
  source: 'none',
  until: null,
  dailyCredits: 800,
  status: 'none',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
  mode: 'test_mode',
  plan: null,
  priceCents: 1000,
}
const unused = () => Effect.die('not used')

/** The real account API served in memory: the plan as `state.plan`, and checkout refused until it is set up. */
const fakeAccount = () => {
  const state = { plan: LAPSED, checkoutReady: false }
  const Billing = HttpApiBuilder.group(AccountApi, 'billing', (handlers) =>
    handlers
      .handle('state', () => Effect.succeed(state.plan))
      .handle('checkout', () =>
        state.checkoutReady
          ? Effect.succeed({ checkoutUrl: 'https://pay.test/checkout/1', sessionId: 'cs_1' })
          : Effect.fail(new BillingRefused({ code: 'billing_unavailable', ref: '8f1e2d3c4b5a6978' })),
      )
      .handle('portal', () => Effect.fail(new BillingRefused({ code: 'no_customer' }))),
  )
  const Clients = HttpApiBuilder.group(AccountApi, 'clients', (handlers) =>
    handlers.handle('list', unused).handle('revoke', unused),
  )
  const ClientErrors = HttpApiBuilder.group(AccountApi, 'clientErrors', (handlers) => handlers.handle('report', unused))
  const server = fakeHttpApi(AccountApi, Layer.mergeAll(Billing, Clients, ClientErrors))
  return {
    ...server,
    state,
    reset: () => {
      state.plan = LAPSED
      state.checkoutReady = false
      server.calls.length = 0
    },
  }
}

const fake = fakeAccount()
beforeAll(() => {
  vi.stubGlobal('location', new URL('http://app.test/'))
  vi.stubGlobal('fetch', fake.fetch)
})
beforeEach(() => fake.reset())
afterAll(async () => {
  vi.unstubAllGlobals()
  await account.runtime.dispose()
  await fake.dispose()
})

describe('billing through the account API', () => {
  it('reads the plan from /api/billing/state, and nothing before someone is signed in', async () => {
    const client = testQueryClient()
    expect(await client.query(billingStateQuery)).toEqual(LAPSED)
    expect(fake.calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/billing/state'])
    expect(signedInBillingQuery(false).queryFn).toBe(skipToken)
  })

  it("explains a checkout that is not set up in the contract's words, with its reference", async () => {
    const client = testQueryClient()
    const checkout = new MutationObserver(client, checkoutMutation)
    const refused = await checkout.mutate().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(BillingRefused)
    expect(messageOf(refused, 'open the checkout', { showRecovery: true })).toBe(
      'Checkout is being set up. Please try again later. · ref 8f1e2d3c',
    )
    const sent = fake.calls.find((call) => new URL(call.url).pathname === '/api/billing/checkout')
    expect(sent?.headers.get('x-goblin-csrf')).toBe('1')
  })

  it('answers a checkout URL once checkout is set up', async () => {
    fake.state.checkoutReady = true
    const checkout = new MutationObserver(testQueryClient(), checkoutMutation)
    expect(await checkout.mutate()).toMatchObject({ checkoutUrl: 'https://pay.test/checkout/1' })
  })
})
