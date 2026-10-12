import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import { afterAll, describe, expect, it } from 'vitest'
import { AccountApi } from './account.ts'
import { BILLING_REFUSALS, BillingRefused } from './billing.ts'
import { Unauthenticated } from './errors.ts'

const STATE = {
  active: false,
  source: 'none',
  until: null,
  dailyCredits: 0,
  status: 'none',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
  mode: null,
  plan: null,
  catalog: [
    { id: 'day', amountUsd: '1.00', periodDays: 1, dailyCredits: 800 },
    { id: 'month', amountUsd: '15.00', periodDays: 30, dailyCredits: 800 },
  ],
} as const

/** The account API with handlers that refuse as asked: `refuse` is the code the next billing write answers. */
let refuse: keyof typeof BILLING_REFUSALS = 'billing_unavailable'
const Handlers = Layer.mergeAll(
  HttpApiBuilder.group(AccountApi, 'billing', (handlers) =>
    handlers
      .handle('state', () => Effect.succeed(STATE))
      .handle('checkout', () => Effect.fail(new BillingRefused({ code: refuse, ref: 'ray-1' })))
      .handle('portal', () => Effect.fail(new BillingRefused({ code: refuse })))
      .handle('walletStart', () => Effect.succeed({ signUrl: 'https://wallet.test/subscribe/x' }))
      .handle('walletConfirm', () => Effect.fail(new BillingRefused({ code: 'payment_short' }))),
  ),
  HttpApiBuilder.group(AccountApi, 'clients', (handlers) =>
    handlers
      .handle('list', () => Effect.fail(new Unauthenticated({ reason: 'session required' })))
      .handle('revoke', () => Effect.succeed({ revoked: true } as const)),
  ),
  HttpApiBuilder.group(AccountApi, 'clientErrors', (handlers) => handlers.handle('report', () => Effect.void)),
)
const server = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(AccountApi).pipe(Layer.provide(Handlers), Layer.provide(HttpServer.layerServices)),
  { disableLogger: true },
)
afterAll(() => server.dispose())
const client = <A, E>(call: (api: HttpApiClient.ForApi<typeof AccountApi>) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.flatMap(HttpApiClient.make(AccountApi, { baseUrl: 'http://account.test' }), call).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) => server.handler(new Request(input, init))),
    ),
  )

describe('the account API', () => {
  it.each(
    (['already_subscribed', 'checkout_limit', 'account_missing', 'billing_unavailable'] as const).map((code) => [
      code,
      BILLING_REFUSALS[code].status,
    ]),
  )('answers a checkout refused as %s with %i, and the client decodes the same refusal', async (code, status) => {
    refuse = code
    const response = await server.handler(new Request('http://account.test/api/billing/checkout', { method: 'POST' }))
    expect(response.status).toBe(status)
    const { status: _status, ...copy } = BILLING_REFUSALS[code]
    expect(await response.json()).toEqual({ error: { code, ...copy, ref: 'ray-1' } })
    expect(await client((api) => Effect.flip(api.billing.checkout()))).toEqual(
      new BillingRefused({ code, ref: 'ray-1' }),
    )
  })

  it('answers the portal with no customer as 404, with no ref when none was stamped', async () => {
    refuse = 'no_customer'
    const response = await server.handler(new Request('http://account.test/api/billing/portal', { method: 'POST' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'no_customer', message: BILLING_REFUSALS.no_customer.message },
    })
  })

  it('starts a wallet subscription for the day pass or monthly, and refuses a start that names neither', async () => {
    expect(await client((api) => api.billing.walletStart({ payload: { plan: 'day', return: '/c/main' } }))).toEqual({
      signUrl: 'https://wallet.test/subscribe/x',
    })
    for (const body of [{}, { plan: 'pro' }, { plan: 'month', return: `/${'a'.repeat(512)}` }]) {
      const response = await server.handler(
        new Request('http://account.test/api/billing/wallet/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('decodes the plan, an admission failure, a revocation and a report', async () => {
    expect(await client((api) => api.billing.state())).toEqual(STATE)
    expect(await client((api) => Effect.flip(api.clients.list()))).toEqual(
      new Unauthenticated({ reason: 'session required' }),
    )
    expect(await client((api) => api.clients.revoke({ params: { clientId: 'client.1' } }))).toEqual({ revoked: true })
    const report = { route: '/c/$chatId', name: 'TypeError', frames: ['https://goblin.test/a.js:1:2'], build: 'b1' }
    expect(await client((api) => api.clientErrors.report({ payload: report }))).toBeUndefined()
  })
})
