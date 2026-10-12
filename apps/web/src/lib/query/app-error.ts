import {
  AppError,
  type ApiCode,
  BILLING_REFUSALS,
  BillingRefused,
  ErrorEnvelope,
  codeOf,
  failureCopy,
  statusOf,
} from '@goblin/contracts/api'
import { onlineManager } from '@tanstack/react-query'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import * as HttpClientError from 'effect/http/HttpClientError'

export type ErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'plan_limit'
  | 'rate_limited'
  | 'unavailable'
  | 'offline'
  | 'cancelled'
  | 'defect'

export interface AppErrorView {
  readonly kind: ErrorKind
  readonly code: string
  readonly status?: number | undefined
  readonly message?: string | undefined
  readonly recovery?: string | undefined
  readonly retryable: boolean
  /** What the owner quotes to find this failure in the logs: the edge's reference, else the browser's request id. */
  readonly ref?: string | undefined
}

export type ErrorKindTable<Code extends string> = Readonly<Record<Code, ErrorKind>>

/** goblin's API codes (`@goblin/contracts/api`): pinned, so a new code needs a kind. */
export const ERROR_KINDS: ErrorKindTable<ApiCode> = {
  unauthenticated: 'unauthenticated',
  forbidden: 'forbidden',
  grant_denied: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  invalid_input: 'validation',
  payload_too_large: 'validation',
  resident_inactive: 'forbidden',
  budget_exhausted: 'plan_limit',
  subscription_required: 'plan_limit',
  needs_authorization: 'forbidden',
  scope_required: 'forbidden',
  upstream_mcp: 'unavailable',
  internal: 'defect',
}
/** The account API's billing refusals (`BillingRefused`), pinned the same way. */
export const BILLING_KINDS: ErrorKindTable<BillingRefused['code']> = {
  billing_unavailable: 'unavailable',
  already_subscribed: 'conflict',
  checkout_limit: 'rate_limited',
  account_missing: 'not_found',
  no_customer: 'not_found',
  card_disabled: 'not_found',
  wallet_unavailable: 'unavailable',
  subscription_unknown: 'not_found',
  subscription_unsigned: 'conflict',
  subscription_ended: 'conflict',
  payment_short: 'plan_limit',
  payment_failed: 'unavailable',
}
const KIND_OF_CODE: ReadonlyMap<string, ErrorKind> = new Map([
  ...Object.entries(ERROR_KINDS),
  ...Object.entries(BILLING_KINDS),
])
const kindOf = (code: string): ErrorKind | undefined => KIND_OF_CODE.get(code)

const isAppError = Schema.is(AppError)
const gateway = (status: number | undefined) => status !== undefined && [502, 503, 504].includes(status)
const kindForStatus = (status: number | undefined): ErrorKind => {
  if (status === 401) return 'unauthenticated'
  if (status === 402) return 'plan_limit'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409 || status === 410) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status !== undefined && status >= 500) return 'unavailable'
  if (status !== undefined && status >= 400) return 'validation'
  return 'defect'
}
/** A typed failure the API answered, as the contract describes it; the `ref` is the one the agent stamped. */
const appView = (error: AppError): AppErrorView => {
  const copy = failureCopy(error)
  const code = codeOf(error._tag)
  const status = statusOf(error)
  return {
    kind: kindOf(code) ?? kindForStatus(status),
    code,
    status,
    message: copy.message,
    recovery: copy.recovery,
    retryable: gateway(status),
    ref: error.ref,
  }
}

/** A billing refusal the account API answered, with its fixed copy; a checkout set up later is worth a retry. */
const billingView = (error: BillingRefused): AppErrorView => {
  const { status, ...copy } = BILLING_REFUSALS[error.code]
  return {
    kind: kindOf(error.code) ?? kindForStatus(status),
    code: error.code,
    status,
    message: copy.message,
    recovery: 'recovery' in copy ? copy.recovery : undefined,
    retryable: gateway(status),
    ref: error.ref,
  }
}

/**
 * The reference an answer carries for the owner to quote, read through `header`: the edge's `x-goblin-ref`, else
 * Cloudflare's `cf-ray`. Without one, a failure quotes the `x-goblin-request` id it was sent with.
 */
export const answerRef = (header: (name: string) => string | null | undefined): string | undefined =>
  header('x-goblin-ref') ?? header('cf-ray') ?? undefined

/** No typed answer: the edge's reference when a response came back, else the id this request was sent with. */
const transportView = (error: HttpClientError.HttpClientError): AppErrorView => {
  const ref = answerRef((name) => error.response?.headers[name]) ?? error.request.headers['x-goblin-request']
  if (Predicate.isTagged(error.reason, 'TransportError'))
    return {
      kind: onlineManager.isOnline() ? 'unavailable' : 'offline',
      code: 'transport_error',
      retryable: true,
      ref,
    }
  const status = error.response?.status
  return {
    kind: kindForStatus(status),
    code: status === undefined ? 'request_failed' : 'http_error',
    status,
    retryable: gateway(status),
    ref,
  }
}

/** An envelope body that reached the caller undecoded (another client, a raw `fetch`). */
const envelopeView = ({ error: detail }: ErrorEnvelope, status: number | undefined): AppErrorView => ({
  kind: kindOf(detail.code) ?? kindForStatus(status),
  code: detail.code,
  status,
  message: detail.message,
  recovery: detail.recovery,
  retryable: gateway(status),
  ref: detail.ref,
})

/** A refusal answered outside the typed API (Better Auth, `/health`): its status, and the reference it quotes. */
const Answered = Schema.Struct({ status: Schema.optionalKey(Schema.Number), ref: Schema.optionalKey(Schema.String) })
type Answered = typeof Answered.Type

/** Normalize typed API errors, error envelopes and transport failures without exposing exception text. */
export function describeError(error: unknown): AppErrorView {
  if (Predicate.isTagged(error, 'ApiDefect')) {
    const kind = Predicate.hasProperty(error, 'interrupted') && error.interrupted === true ? 'cancelled' : 'defect'
    return { kind, code: kind, retryable: false }
  }
  if (Predicate.isTagged(error, 'SchemaError')) return { kind: 'defect', code: 'contract_drift', retryable: false }
  if (isAppError(error)) return appView(error)
  if (error instanceof BillingRefused) return billingView(error)
  if (HttpClientError.isHttpClientError(error)) return transportView(error)
  const envelope = Schema.decodeUnknownOption(ErrorEnvelope)(error)
  const { status, ref } = Option.getOrElse(Schema.decodeUnknownOption(Answered)(error), (): Answered => ({}))
  if (Option.isSome(envelope)) return envelopeView(envelope.value, status)
  return {
    kind: kindForStatus(status),
    code: status === undefined ? 'defect' : 'http_error',
    status,
    retryable: false,
    ...(ref === undefined ? {} : { ref }),
  }
}

/**
 * `text` ending with a reference to quote ("… · ref 7f3a9c12"): its first eight characters are enough to find it
 * (`goblin lookup`). The one place copy gains its reference.
 */
const quoting = (text: string, ref: string | undefined): string =>
  ref === undefined ? text : `${text} · ref ${ref.slice(0, 8)}`

/** The page's own words for a failure it expects (a name in use, a move under way), with the failure's reference. */
export const withRef = (text: string, failure: unknown): string => quoting(text, describeError(failure).ref)

/**
 * Calm action copy, ending with the failure's reference when there is one. Typed server messages are public; exception
 * text and status codes are not.
 */
/** What the free plan waits for when the day's allowance is none: a funded Goblin Wallet (ADR 0047). */
export const WALLET_NEEDED =
  'The free plan needs a Goblin Wallet holding at least $5. Connect one on Connections, or choose to pay per call in Settings.'

/** A spent day that was never open: a budget refusal with no allowance at all. */
const walletNeeded = (error: unknown): boolean =>
  Predicate.isTagged(error, 'BudgetExhausted') && Predicate.hasProperty(error, 'limit') && error.limit === 0

export function messageOf(
  error: unknown,
  action: string,
  opts: { readonly showRecovery?: boolean | undefined } = {},
): string {
  const view = describeError(error)
  if (walletNeeded(error)) return quoting(WALLET_NEEDED, view.ref)
  if (view.message !== undefined)
    return quoting(
      `${view.message}${opts.showRecovery === true && view.recovery !== undefined ? ` ${view.recovery}` : ''}`,
      view.ref,
    )
  const copy: Record<ErrorKind, string> = {
    offline: 'You are offline; try again when you reconnect.',
    unavailable: 'The service is not answering. Try again in a minute.',
    unauthenticated: 'Sign in again.',
    forbidden: 'You do not have access. Review your permissions.',
    not_found: 'This item no longer exists.',
    conflict: 'Refresh and try again.',
    validation: 'Check the details and try again.',
    plan_limit: 'Your plan has reached its limit. Review your plan.',
    rate_limited: 'Wait a moment and try again.',
    defect: 'Try again.',
    cancelled: 'Try again.',
  }
  return quoting(`Could not ${action}. ${copy[view.kind]}`, view.ref)
}
