/**
 * goblin as a merchant of the Goblin Wallet (ADR 0054): the wallet's merchant API, server to server with goblin's
 * bearer merchant key (`WALLET_MERCHANT_KEY`, the wallet's `WALLET_MERCHANT_GOBLIN_KEY`). goblin asks for a
 * subscription the owner signs once in the wallet, reads it, and collects one period at a time. The schemas mirror
 * `@goblin/wallet/contract`'s `merchant.ts`, which this Worker may not import.
 */
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type { RuntimeEnv } from '../env.ts'
import { PRO } from './plans.ts'

/** The wallet did not answer, or answered something other than the contract: the caller may retry. */
export class WalletMerchantError extends Schema.TaggedError<WalletMerchantError>()('WalletMerchantError', {
  message: Schema.String,
}) {}

/** Pro's terms as the owner signs them: the plan's price every 30 days, for 12 payments. */
export const WALLET_TERMS = {
  plan: 'pro',
  amountUsd: `${String(Math.floor(PRO.priceCents / 100))}.${String(PRO.priceCents % 100).padStart(2, '0')}`,
  periodDays: 30,
  months: 12,
} as const

const Id = Schema.String.check(Schema.isPattern(/^sub_[0-9a-f]{32}$/u))
const Hex = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]*$/u))

const Created = Schema.Struct({ id: Id, signUrl: Schema.String, expiresAt: Schema.String })
export type WalletRequestCreated = typeof Created.Type

const Subscription = Schema.Struct({
  id: Id,
  reference: Schema.String,
  status: Schema.Literals(['pending', 'active', 'revoked', 'expired']),
  owner: Schema.optional(Schema.String),
  chain: Schema.Literal('base'),
  amountUsd: Schema.String,
  periodDays: Schema.Number,
  startsAt: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  delegationHash: Schema.optional(Hex),
  collector: Schema.String,
  shortUsd: Schema.optional(Schema.String),
})
export type WalletSubscriptionView = typeof Subscription.Type

const Collection = Schema.Struct({
  status: Schema.Literals(['paid', 'pending', 'failed']),
  reason: Schema.optional(Schema.Literals(['insufficient_funds', 'revoked', 'expired', 'not_due', 'chain'])),
  userOpHash: Schema.optional(Hex),
  txHash: Schema.optional(Hex),
  paidAt: Schema.optional(Schema.String),
})
export type WalletCollection = typeof Collection.Type

export interface WalletMerchantApi {
  /** The wallet's origin: where the owner signs, and Manage in the wallet goes. */
  readonly origin: string
  /** A subscription request for `reference` (goblin's account); the owner signs it at `signUrl`, then returns. */
  readonly create: (request: {
    readonly reference: string
    readonly returnUrl: string
  }) => Effect.Effect<WalletRequestCreated, WalletMerchantError>
  readonly get: (id: string) => Effect.Effect<WalletSubscriptionView, WalletMerchantError>
  /** Period `period`'s payment, at most once per period whatever `operationId` says. */
  readonly collect: (
    id: string,
    request: { readonly period: number; readonly operationId: string },
  ) => Effect.Effect<WalletCollection, WalletMerchantError>
}

/** The merchant client, a service so the billing programs' tests can give a fake. */
export class WalletMerchant extends Context.Service<WalletMerchant, WalletMerchantApi>()(
  'goblin/billing/WalletMerchant',
) {}

/** One merchant call's JSON answer; any failure (network, status, body) is a `WalletMerchantError`. */
const call = (
  origin: string,
  key: string,
  route: { readonly method: 'GET' | 'POST'; readonly path: string; readonly body?: Record<string, unknown> },
): Effect.Effect<unknown, WalletMerchantError> => {
  const url = `${origin}${route.path}`
  const base = route.method === 'GET' ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
  const request = HttpClientRequest.setHeader(base, 'authorization', `Bearer ${key}`)
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      route.body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, route.body),
    )
    if (response.status < 200 || response.status >= 300)
      return yield* new WalletMerchantError({ message: `The wallet answered ${String(response.status)}.` })
    const answer: unknown = yield* response.json
    return answer
  }).pipe(
    Effect.scoped,
    Effect.timeout('90 seconds'),
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((error) =>
      error instanceof WalletMerchantError
        ? error
        : new WalletMerchantError({ message: 'The wallet could not be reached.' }),
    ),
  )
}

/** An answer off the contract is the wallet's fault, as a failed call is. */
const offContract = () => new WalletMerchantError({ message: 'The wallet answered off contract.' })
const decodeCreated = (answer: unknown) => Effect.mapError(Schema.decodeUnknownEffect(Created)(answer), offContract)
const decodeSubscription = (answer: unknown) =>
  Effect.mapError(Schema.decodeUnknownEffect(Subscription)(answer), offContract)
const decodeCollection = (answer: unknown) =>
  Effect.mapError(Schema.decodeUnknownEffect(Collection)(answer), offContract)

const subscriptionPath = (id: string): string => `/api/merchant/subscriptions/${encodeURIComponent(id)}`

/** The live client of the wallet at `origin`, with goblin's merchant key. */
export const liveMerchant = (origin: string, key: string): WalletMerchantApi => ({
  origin,
  create: ({ reference, returnUrl }) =>
    call(origin, key, {
      method: 'POST',
      path: '/api/merchant/subscriptions',
      body: { ...WALLET_TERMS, reference, returnUrl },
    }).pipe(Effect.flatMap(decodeCreated)),
  get: (id) =>
    call(origin, key, { method: 'GET', path: subscriptionPath(id) }).pipe(Effect.flatMap(decodeSubscription)),
  collect: (id, request) =>
    call(origin, key, { method: 'POST', path: `${subscriptionPath(id)}/collect`, body: { ...request } }).pipe(
      Effect.flatMap(decodeCollection),
    ),
})

/** The wallet as a merchant on this deployment, or none when its origin or the merchant key is not set. */
export const configuredMerchant = (env: RuntimeEnv): WalletMerchantApi | undefined => {
  const origin = env.WALLET_ORIGIN ?? ''
  const key = env.WALLET_MERCHANT_KEY ?? ''
  if (origin === '' || key === '' || !URL.canParse(origin)) return undefined
  return liveMerchant(new URL(origin).origin, key)
}

/** Whether the card checkout (Dodo, ADR 0015) is on: off unless `CARD_CHECKOUT` says `on` (ADR 0054). */
export const cardCheckoutOn = (env: RuntimeEnv): boolean => env.CARD_CHECKOUT === 'on' || env.CARD_CHECKOUT === '1'
