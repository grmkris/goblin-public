/** Browser billing commands, separate from agent admission; checkout returns no entitlement. */
import { Clock, Effect } from 'effect'
import type { RuntimeEnv } from '../env.ts'
import { configuredDodo } from './dodo.ts'
import { billingMode } from './gates.ts'
import type { BillingDeps } from './events.ts'
import { planOf } from './reconcile.ts'
import { makeBillingStore } from './store.ts'

export const billingDeps = (env: RuntimeEnv): BillingDeps | undefined => {
  const dodo = configuredDodo(env)
  return dodo === undefined
    ? undefined
    : { store: makeBillingStore(env.AUTH_DB), dodo, productId: env.DODO_PRODUCT_ID ?? '' }
}
export const startCheckout = Effect.fn('billing.startCheckout')(function* (
  deps: BillingDeps,
  userId: string,
  appUrl: string,
  stage: string,
) {
  const now = yield* Clock.currentTimeMillis
  const plan = yield* planOf(deps.store, userId, stage, deps.dodo.mode, now)
  if (plan.active) return { error: 'already_subscribed', status: 409 } as const
  if ((yield* deps.store.checkoutCount(userId, now - 60_000)) >= 5)
    return { error: 'checkout_limit', status: 429 } as const
  const account = yield* deps.store.account(userId)
  const contact = yield* deps.store.contact(userId)
  if (contact === undefined) return { error: 'account_missing', status: 404 } as const
  const customer =
    account?.customerId == null ? { email: contact.email, name: contact.name } : { customerId: account.customerId }
  const checkout = yield* deps.dodo.createCheckout({
    productId: deps.productId,
    customer,
    returnUrl: new URL('/subscribe/success', appUrl).href,
    metadata: { userId, plan: 'pro' },
  })
  yield* deps.store.recordCheckout(checkout.sessionId, userId, now)
  return { checkoutUrl: checkout.checkoutUrl, sessionId: checkout.sessionId, status: 200 } as const
})
export const billingApi = Effect.fn('billing.api')(function* (request: Request, env: RuntimeEnv, userId: string) {
  const path = new URL(request.url).pathname
  const store = makeBillingStore(env.AUTH_DB)
  const deps = billingDeps(env)
  if (path === '/api/billing/state' && request.method === 'GET') {
    const plan = yield* planOf(store, userId, env.STAGE ?? 'test', billingMode(env))
    return Response.json({ ...plan, mode: deps?.dodo.mode ?? null, plan: plan.active ? 'pro' : null, priceCents: 1000 })
  }
  if (deps === undefined) return Response.json({ error: 'billing_unavailable' }, { status: 503 })
  if (path === '/api/billing/checkout' && request.method === 'POST') {
    const { status, ...body } = yield* startCheckout(deps, userId, env.APP_URL, env.STAGE ?? 'test')
    return Response.json(body, { status })
  }
  if (path === '/api/billing/portal' && request.method === 'POST') {
    const account = yield* store.account(userId)
    if (account?.customerId == null) return Response.json({ error: 'no_customer' }, { status: 404 })
    return Response.json({ url: yield* deps.dodo.portalUrl(account.customerId) })
  }
  return Response.json({ error: 'NotFound' }, { status: 404 })
})
