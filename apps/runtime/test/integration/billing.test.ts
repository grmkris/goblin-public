import { callAccount, callOwner } from '../owner-client.ts'
import { call, lever, person, signedIn, type Person } from './owner-requests.ts'
import { answerOf } from './probe-reads.ts'
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Test from 'alchemy/Test/Vitest'
import { Effect, Schema } from 'effect'
import { createHmac } from 'node:crypto'
import { expect } from 'vitest'
import Stack from './billing-stack.ts'
const harness = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: 'test_billing',
  dev: true,
})
const stack = harness.beforeAll(harness.deploy(Stack))
const KEY = 'whsec_Zml4dHVyZS1iaWxsaW5nLXNpZ25pbmcta2V5'
const Checkout = Schema.Struct({ checkoutUrl: Schema.String })
const DAY = 86_400_000
/** A billing test lever for `who` (`/__test/billing/<action>`), its JSON answer. */
const billing = async (base: string, who: Person, action: string, extra: Record<string, unknown> = {}) =>
  (await lever(base, who, `billing/${action}`, { userId: who.userId, ...extra })).json()
async function deliver(
  base: string,
  who: Person,
  patch: Record<string, unknown> = {},
  id = crypto.randomUUID(),
  timestamp = Date.now(),
) {
  const body = JSON.stringify({
    type: 'subscription.updated',
    timestamp: new Date(timestamp).toISOString(),
    data: {
      subscription_id: `sub_${who.userId}`,
      product_id: 'pdt_goblin_fixture',
      status: 'active',
      customer: { customer_id: `cus_${who.userId}` },
      next_billing_date: new Date(Date.now() + 30 * DAY).toISOString(),
      metadata: { userId: who.userId },
      ...patch,
    },
  })
  const sent = Math.floor(Date.now() / 1000)
  const signature = `v1,${createHmac('sha256', Buffer.from(KEY.slice(6), 'base64'))
    .update(`${id}.${sent}.${body}`)
    .digest('base64')}`
  const response = await fetch(`${base}/hooks/dodo`, {
    method: 'POST',
    headers: { 'webhook-id': id, 'webhook-timestamp': String(sent), 'webhook-signature': signature },
    body,
  })
  // Webhook acceptance precedes application. Observe the durable receipt before asserting the resulting plan.
  if (response.ok)
    await expect.poll(() => billing(base, who, 'inbox', { eventId: id })).toMatchObject({ state: 'processed' })
  return response
}
async function active(base: string, who: Person, enabled: boolean) {
  await expect
    .poll(async () => (await callAccount(signedIn(base, who), (api) => api.billing.state())).active)
    .toBe(enabled)
}

/** The agent's usage as `who` reads it: `ok`, or the tag of the plan admission's refusal. */
const usage = (base: string, who: Person) => answerOf(signedIn(base, who), (api) => api.agent.usage())
const usageToday = (base: string, who: Person) => callOwner(signedIn(base, who), (api) => api.agent.usage())

async function activationCase(url: string) {
  const who = await person(url)
  expect(await usage(url, who)).toBe('SubscriptionRequired')
  // The checkout ignores what the browser says about the product and the account.
  const checkout = await call(url, who, '/api/billing/checkout', {
    productId: 'attacker-product',
    userId: 'another-user',
  })
  expect(checkout.status).toBe(200)
  const link = new URL(Schema.decodeUnknownSync(Checkout)(await checkout.json()).checkoutUrl)
  expect(link.searchParams.get('product')).toBe('pdt_goblin_fixture')
  expect(link.searchParams.get('user')).toBe(who.userId)
  expect(link.searchParams.get('return')).toBe('https://goblin.test/subscribe/success')
  expect(await usage(url, who)).toBe('SubscriptionRequired')
  const id = crypto.randomUUID()
  expect((await deliver(url, who, {}, id)).status).toBe(200)
  await active(url, who, true)
  expect(await usageToday(url, who)).toMatchObject({ limit: 800 })
  expect((await call(url, who, '/api/billing/checkout', {})).status).toBe(409)
  expect((await deliver(url, who, { status: 'expired' }, id)).status).toBe(200)
  await active(url, who, true)
  expect(await billing(url, who, 'inbox', { eventId: id })).toMatchObject({ state: 'processed', attempts: 1 })
  expect((await deliver(url, who, { status: 'expired' }, crypto.randomUUID(), Date.now() - DAY)).status).toBe(200)
  await active(url, who, true)
  expect(
    (
      await fetch(`${url}/hooks/dodo`, {
        method: 'POST',
        headers: {
          'webhook-id': 'bad',
          'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'webhook-signature': 'v1,AAAA',
        },
        body: '{}',
      })
    ).status,
  ).toBe(401)
}

harness.test(
  'local workerd: billing signup, injected checkout, verified activation and durable replay admission',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => activationCase(url))
  }),
)

async function cancellationCase(url: string) {
  const who = await person(url)
  const end = Date.now() + DAY
  await deliver(url, who, {
    status: 'cancelled',
    cancel_at_next_billing_date: true,
    next_billing_date: new Date(end).toISOString(),
  })
  await active(url, who, true)
  expect(await billing(url, who, 'state', { at: end - 1 })).toMatchObject({ active: true, cancelAtPeriodEnd: true })
  expect(await billing(url, who, 'state', { at: end })).toMatchObject({ active: false })
  const expired = crypto.randomUUID()
  await deliver(url, who, { status: 'cancelled', next_billing_date: new Date(Date.now() - DAY).toISOString() }, expired)
  await active(url, who, false)
  expect(await usage(url, who)).toBe('SubscriptionRequired')
  const grace = Date.now() + DAY
  await deliver(url, who, {
    status: 'on_hold',
    next_billing_date: new Date(Date.now() - DAY).toISOString(),
    past_due_ends_at: new Date(grace).toISOString(),
  })
  await active(url, who, true)
  expect(await billing(url, who, 'state', { at: grace })).toMatchObject({ active: false })
  await deliver(url, who, {
    status: 'past_due',
    next_billing_date: new Date(Date.now() - DAY).toISOString(),
    past_due_ends_at: null,
  })
  await active(url, who, true)
  expect(await billing(url, who, 'state', { at: Date.now() + 3 * DAY })).toMatchObject({ active: false })
  await deliver(url, who, { status: 'expired' })
  await active(url, who, false)
}

harness.test(
  'local workerd: billing cancellation expires at its paid period; renewal grace ends exactly',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => cancellationCase(url))
  }),
)

async function allowanceCase(url: string) {
  const first = await person(url)
  const second = await person(url)
  await billing(url, first, 'override', { dailyCredits: 17 })
  await billing(url, second, 'override', { dailyCredits: 1234 })
  expect(await usageToday(url, first)).toMatchObject({ used: 0, limit: 17 })
  expect(await usageToday(url, second)).toMatchObject({ used: 0, limit: 1234 })
  expect(await billing(url, first, 'as-prod')).toMatchObject({ active: false, dailyCredits: 0 })
  const stranger = await person(url)
  expect(await usage(url, stranger)).toBe('SubscriptionRequired')
}

harness.test(
  'local workerd: billing operator allowance belongs to one account and grants nothing on prod',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => allowanceCase(url))
  }),
)

async function recoveryCase(url: string) {
  const who = await person(url)
  const id = crypto.randomUUID()
  const body = JSON.stringify({
    data: {
      subscription_id: `sub_${who.userId}`,
      product_id: 'pdt_goblin_fixture',
      status: 'active',
      customer: { customer_id: `cus_${who.userId}` },
      next_billing_date: new Date(Date.now() + DAY).toISOString(),
      metadata: { userId: who.userId },
    },
  })
  await billing(url, who, 'pending', { eventId: id, body })
  expect(await usage(url, who)).toBe('SubscriptionRequired')
  await billing(url, who, 'cron')
  await active(url, who, true)
  expect(await billing(url, who, 'inbox', { eventId: id })).toMatchObject({ state: 'processed', attempts: 1 })
  await billing(url, who, 'cron')
  expect(await billing(url, who, 'inbox', { eventId: id })).toMatchObject({ state: 'processed', attempts: 1 })
}
harness.test(
  'local workerd: billing cron recovers a durable accepted event without a background run',
  Effect.gen(function* () {
    const { url } = yield* stack
    yield* Effect.promise(() => recoveryCase(url))
  }),
)
