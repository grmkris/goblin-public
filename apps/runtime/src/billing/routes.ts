/** Billing commands for the account API (`http/api/account.ts`), apart from agent admission; no entitlement here. */
import { Clock, Effect } from 'effect'
import type { RuntimeEnv } from '../env.ts'
import { configuredDodo } from './dodo.ts'
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
