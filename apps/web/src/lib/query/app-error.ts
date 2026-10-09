import {
  AppError,
  type ApiCode,
  BILLING_REFUSALS,
  BillingRefused,
  ERROR_COPY,
  ErrorEnvelope,
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
  | 'capacity'
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
  readonly recoveryHref?: string | undefined
  readonly retryable: boolean
  readonly retryAfterMs?: number | undefined
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
}
const KIND_OF_CODE: ReadonlyMap<string, ErrorKind> = new Map([
  ...Object.entries(ERROR_KINDS),
  ...Object.entries(BILLING_KINDS),
])
const kindOf = (code: string, codes: Readonly<Record<string, ErrorKind>>): ErrorKind | undefined =>
  codes[code] ?? KIND_OF_CODE.get(code)

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
/** A same-site path (`/subscribe`) or an http(s) URL; anything else is not a link to offer. */
const recoveryLink = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined
  } catch {
    // expected: a recovery that is not a URL is not offered as a link.
    return undefined
  }
}

/** A typed failure the API answered, as the contract describes it; the `ref` is the one the agent stamped. */
const appView = (error: AppError, codes: Readonly<Record<string, ErrorKind>>): AppErrorView => {
  const copy = ERROR_COPY[error._tag]
  const status = statusOf(error)
  const subscribe = Predicate.isTagged(error, 'SubscriptionRequired') ? recoveryLink(error.subscribe) : undefined
  return {
    kind: kindOf(copy.code, codes) ?? kindForStatus(status),
    code: copy.code,
    status,
    message: copy.message,
    recovery: 'recovery' in copy ? copy.recovery : undefined,
    recoveryHref: subscribe,
    retryable: gateway(status),
    ref: error.ref,
  }
}

/** A billing refusal the account API answered, with its fixed copy; a checkout set up later is worth a retry. */
const billingView = (error: BillingRefused, codes: Readonly<Record<string, ErrorKind>>): AppErrorView => {
  const { status, ...copy } = BILLING_REFUSALS[error.code]
  return {
    kind: kindOf(error.code, codes) ?? kindForStatus(status),
    code: error.code,
    status,
    message: copy.message,
    recovery: 'recovery' in copy ? copy.recovery : undefined,
    retryable: gateway(status),
    ref: error.ref,
  }
}

/** No typed answer: the edge's reference when a response came back, else the id this request was sent with. */
const transportView = (error: HttpClientError.HttpClientError): AppErrorView => {
  const ref = error.response?.headers['x-goblin-ref'] ?? error.request.headers['x-goblin-request']
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
const envelopeView = (
  { error: detail }: ErrorEnvelope,
  codes: Readonly<Record<string, ErrorKind>>,
  status: number | undefined,
): AppErrorView => ({
  kind: kindOf(detail.code, codes) ?? kindForStatus(status),
  code: detail.code,
  status,
  message: detail.message,
  recovery: detail.recovery,
  recoveryHref: recoveryLink(detail.subscribe),
  retryable: gateway(status),
  ref: detail.ref,
})

const WithStatus = Schema.Struct({ status: Schema.optionalKey(Schema.Number) })

/** Normalize typed API errors, error envelopes and transport failures without exposing exception text. */
export function describeError(error: unknown, codes: Readonly<Record<string, ErrorKind>> = {}): AppErrorView {
  if (Predicate.isTagged(error, 'ApiDefect')) {
    const kind = Predicate.hasProperty(error, 'interrupted') && error.interrupted === true ? 'cancelled' : 'defect'
    return { kind, code: kind, retryable: false }
  }
  if (Predicate.isTagged(error, 'SchemaError')) return { kind: 'defect', code: 'contract_drift', retryable: false }
  if (isAppError(error)) return appView(error, codes)
  if (error instanceof BillingRefused) return billingView(error, codes)
  if (HttpClientError.isHttpClientError(error)) return transportView(error)
  const envelope = Schema.decodeUnknownOption(ErrorEnvelope)(error)
  const status = Option.getOrUndefined(Schema.decodeUnknownOption(WithStatus)(error))?.status
  if (Option.isSome(envelope)) return envelopeView(envelope.value, codes, status)
  return { kind: kindForStatus(status), code: status === undefined ? 'defect' : 'http_error', status, retryable: false }
}

/** How a reference reads in copy: its first eight characters are enough to find it (`goblin lookup`). */
const shortRef = (ref: string): string => ref.slice(0, 8)

/**
 * Calm action copy, ending with the failure's reference ("… · ref 7f3a9c12") when there is one. Typed server messages
 * are public; exception text and status codes are not.
 */
export function messageOf(
  error: unknown,
  action: string,
  opts: {
    readonly showRecovery?: boolean | undefined
    readonly codes?: Readonly<Record<string, ErrorKind>> | undefined
  } = {},
): string {
  const view = describeError(error, opts.codes)
  const ref = view.ref === undefined ? '' : ` · ref ${shortRef(view.ref)}`
  if (view.message !== undefined)
    return `${view.message}${opts.showRecovery === true && view.recovery !== undefined ? ` ${view.recovery}` : ''}${ref}`
  const copy: Record<ErrorKind, string> = {
    offline: 'You are offline; try again when you reconnect.',
    unavailable: 'The service is not answering. Try again in a minute.',
    unauthenticated: 'Sign in again.',
    forbidden: 'You do not have access. Review your permissions.',
    not_found: 'This item no longer exists.',
    conflict: 'Refresh and try again.',
    validation: 'Check the details and try again.',
    plan_limit: 'Your plan has reached its limit. Review your plan.',
    capacity: 'There is no capacity available. Try again later.',
    rate_limited: 'Wait a moment and try again.',
    defect: 'Try again.',
    cancelled: 'Try again.',
  }
  return `Could not ${action}. ${copy[view.kind]}${ref}`
}
