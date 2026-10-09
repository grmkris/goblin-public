import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { BillingState } from '../billing.ts'
import { API_ERRORS } from './errors.ts'

/**
 * Why billing refused a checkout or the portal: its status and fixed copy, never runtime text. The codes and statuses
 * are the ones the billing routes have always answered.
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
} as const satisfies Record<string, { readonly status: number; readonly message: string; readonly recovery?: string }>
type BillingCode = keyof typeof BILLING_REFUSALS
const BillingCode = Schema.Literals([
  'billing_unavailable',
  'already_subscribed',
  'checkout_limit',
  'account_missing',
  'no_customer',
] as const satisfies readonly BillingCode[])

/** Billing refused the request; `code` says why. `ref` is the reference the answer quotes, as on `AppError`. */
export class BillingRefused extends Schema.TaggedError<BillingRefused>()('BillingRefused', {
  code: BillingCode,
  ref: Schema.optionalKey(Schema.String),
}) {}

/**
 * The envelope of the refusals one status answers, as `errors.ts` builds the `AppError` ones: `{ error: { code,
 * message, recovery?, ref? } }` on the wire, `BillingRefused` on either side, and only `codes` encode through it, so
 * a union of these picks the refusal's own status.
 */
const refusal = <const Codes extends readonly [BillingCode, ...BillingCode[]]>(status: number, codes: Codes) => {
  const member = (code: BillingCode): code is Codes[number] => codes.some((known) => known === code)
  const Wire = Schema.Struct({
    error: Schema.Struct({
      code: Schema.Literals(codes),
      message: Schema.String,
      recovery: Schema.optionalKey(Schema.String),
      ref: Schema.optionalKey(Schema.String),
    }),
  }).annotate({ identifier: `BillingRefused${status}` })
  return Wire.pipe(
    Schema.decodeTo(
      BillingRefused,
      SchemaTransformation.transformEffect({
        decode: ({ error: { code, ref } }) =>
          Effect.succeed({ _tag: 'BillingRefused' as const, code, ...(ref === undefined ? {} : { ref }) }),
        encode: (refused, options) => {
          const { code, ref } = refused
          if (!member(code))
            return Effect.fail(new SchemaIssue.InvalidValue({ message: `Not a ${status} refusal.` }, refused, options))
          const { status: _status, ...copy } = BILLING_REFUSALS[code]
          return Effect.succeed({ error: { code, ...copy, ...(ref === undefined ? {} : { ref }) } })
        },
      }),
    ),
    HttpApiSchema.status(status),
  )
}

const Refusals = {
  unavailable: refusal(503, ['billing_unavailable']),
  alreadySubscribed: refusal(409, ['already_subscribed']),
  checkoutLimit: refusal(429, ['checkout_limit']),
  missing: refusal(404, ['account_missing', 'no_customer']),
}

/** A checkout the payment provider opened: where to send the owner. Its return URL never proves payment. */
const CheckoutStarted = Schema.Struct({ checkoutUrl: Schema.String, sessionId: Schema.String })
/** The payment provider's portal, where the owner manages or cancels their subscription. */
const PortalLink = Schema.Struct({ url: Schema.String })

/**
 * The account's plan and checkout, served by the Worker for any signed-in account, with or without a plan. Paths are
 * relative to the API's `/api` prefix. Writes need the app's Origin and the CSRF header. Like every owner endpoint,
 * each can answer any `AppError` envelope (`API_ERRORS`), the edge's admission refusals among them.
 *
 * - `state`: `GET /api/billing/state`, the plan as it stands.
 * - `checkout`: `POST /api/billing/checkout` opens a Pro checkout for the signed-in account; any body is ignored.
 * - `portal`: `POST /api/billing/portal`, the provider's portal for an account that has paid before.
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
) {}
