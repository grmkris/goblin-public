import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { BillingState, WalletReceipt } from '../billing.ts'
import { API_ERRORS, statusEnvelope } from './errors.ts'

/**
 * Why billing refused a checkout or the portal: its status and fixed copy, never runtime text.
 */
export const BILLING_REFUSALS = {
  billing_unavailable: { status: 503, message: 'Checkout is being set up.', recovery: 'Please try again later.' },
  already_subscribed: { status: 409, message: 'You already have Pro.' },
  checkout_limit: {
    status: 429,
    message: 'Too many checkouts were started.',
    recovery: 'Wait a minute and try again.',
  },
  account_missing: { status: 404, message: 'Your account was not found.' },
  no_customer: { status: 404, message: 'There is no subscription to manage yet.' },
  card_disabled: {
    status: 404,
    message: 'Card checkout is off.',
    recovery: 'Subscribe with USDC from your Goblin Wallet.',
  },
  wallet_unavailable: {
    status: 503,
    message: 'The Goblin Wallet did not answer.',
    recovery: 'Please try again in a moment.',
  },
  subscription_unknown: { status: 404, message: 'That subscription was not found.', recovery: 'Start again from Pro.' },
  subscription_unsigned: {
    status: 409,
    message: 'The subscription is not signed yet.',
    recovery: 'Sign it in your Goblin Wallet.',
  },
  subscription_ended: {
    status: 409,
    message: 'That subscription was cancelled or has ended.',
    recovery: 'Subscribe again.',
  },
  payment_short: {
    status: 409,
    message: 'Your Goblin Wallet is short of the first payment.',
    recovery: 'Add USDC on Base, then try again.',
  },
  payment_failed: { status: 502, message: 'The payment did not go through.', recovery: 'Try again in a moment.' },
} as const satisfies Record<string, { readonly status: number; readonly message: string; readonly recovery?: string }>
type BillingCode = keyof typeof BILLING_REFUSALS
const BillingCode = Schema.Literals([
  'billing_unavailable',
  'already_subscribed',
  'checkout_limit',
  'account_missing',
  'no_customer',
  'card_disabled',
  'wallet_unavailable',
  'subscription_unknown',
  'subscription_unsigned',
  'subscription_ended',
  'payment_short',
  'payment_failed',
] as const satisfies readonly BillingCode[])

/** Billing refused the request; `code` says why. `ref` is the reference the answer quotes, as on `AppError`. */
export class BillingRefused extends Schema.TaggedError<BillingRefused>()('BillingRefused', {
  code: BillingCode,
  ref: Schema.optionalKey(Schema.String),
}) {}

/** The envelope of the refusals `codes` (one status's), built as the `AppError` ones are (`statusEnvelope`). */
const refusal = (status: number, codes: readonly [BillingCode, ...BillingCode[]]) =>
  statusEnvelope(status, `BillingRefused${status}`, codes, BillingRefused, {
    toWire: ({ code, ref }) => {
      if (!codes.includes(code)) return undefined
      const { status: _status, ...copy } = BILLING_REFUSALS[code]
      return { error: { code, ...copy, ...(ref === undefined ? {} : { ref }) } }
    },
    fromWire: ({ code, ref }) => ({ _tag: 'BillingRefused', code, ...(ref === undefined ? {} : { ref }) }),
  })

const Refusals = {
  unavailable: refusal(503, ['billing_unavailable', 'wallet_unavailable']),
  alreadySubscribed: refusal(409, ['already_subscribed']),
  checkoutLimit: refusal(429, ['checkout_limit']),
  missing: refusal(404, ['account_missing', 'no_customer', 'card_disabled', 'subscription_unknown']),
  unpaid: refusal(409, ['subscription_unsigned', 'subscription_ended', 'payment_short']),
  failed: refusal(502, ['payment_failed']),
}

/** A checkout the payment provider opened: where to send the owner. Its return URL never proves payment. */
const CheckoutStarted = Schema.Struct({ checkoutUrl: Schema.String, sessionId: Schema.String })
/** The payment provider's portal, where the owner manages or cancels their subscription. */
const PortalLink = Schema.Struct({ url: Schema.String })
/** Where the owner goes back to once the subscription is signed: a path of this app, `/` when absent. */
const WalletStart = Schema.Struct({ return: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))) })
/** The Goblin Wallet's page where the owner signs the subscription once. */
const WalletStarted = Schema.Struct({ signUrl: Schema.String })
/** The subscription the wallet sent the owner back with. */
const WalletConfirm = Schema.Struct({ subscription: Schema.String.check(Schema.isPattern(/^sub_[0-9a-f]{32}$/u)) })

/**
 * The account's plan and checkout, served by the Worker for any signed-in account, with or without a plan. Paths are
 * relative to the API's `/api` prefix. Writes need the app's Origin and the CSRF header. Like every owner endpoint,
 * each can answer any `AppError` envelope (`API_ERRORS`), the edge's admission refusals among them.
 *
 * - `state`: `GET /api/billing/state`, the plan as it stands.
 * - `checkout`: `POST /api/billing/checkout` opens a Pro checkout for the signed-in account; any body is ignored.
 * - `portal`: `POST /api/billing/portal`, the provider's portal for an account that has paid before.
 *   Both answer `card_disabled` unless the deployment turns the card checkout on.
 * - `walletStart`: `POST /api/billing/wallet/start` asks the Goblin Wallet for a Pro subscription the owner signs once
 *   (ADR 0054) and answers where to sign it; the wallet sends the owner back to `/subscribe/success`.
 * - `walletConfirm`: `POST /api/billing/wallet/confirm` reads the signed subscription, takes the first period's payment
 *   and answers its receipt; repeating it answers the same receipt.
 */
export class BillingGroup extends HttpApiGroup.make('billing').add(
  HttpApiEndpoint.get('state', '/billing/state', { success: BillingState, error: API_ERRORS }),
  HttpApiEndpoint.post('checkout', '/billing/checkout', {
    success: CheckoutStarted,
    error: [...API_ERRORS, Refusals.unavailable, Refusals.alreadySubscribed, Refusals.checkoutLimit, Refusals.missing],
  }),
  HttpApiEndpoint.post('portal', '/billing/portal', {
    success: PortalLink,
    error: [...API_ERRORS, Refusals.unavailable, Refusals.missing],
  }),
  HttpApiEndpoint.post('walletStart', '/billing/wallet/start', {
    payload: WalletStart,
    success: WalletStarted,
    error: [...API_ERRORS, Refusals.unavailable, Refusals.alreadySubscribed, Refusals.checkoutLimit],
  }),
  HttpApiEndpoint.post('walletConfirm', '/billing/wallet/confirm', {
    payload: WalletConfirm,
    success: WalletReceipt,
    error: [...API_ERRORS, Refusals.unavailable, Refusals.missing, Refusals.unpaid, Refusals.failed],
  }),
) {}
