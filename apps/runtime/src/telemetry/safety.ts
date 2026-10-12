import { ChatId, OperationId, TopicId } from '@goblin/contracts'
import {
  FlowActor,
  FlowName,
  FlowStatus,
  FlowVia,
  PersonaOrder,
  RunAttribute,
  type RunAttributes,
} from '@goblin/contracts/telemetry'
import * as Schema from 'effect/Schema'

/** Only host-owned classifications may describe a failure in telemetry. Text lives in Pi, never here. */
const FAILURES: Readonly<Record<string, string>> = {
  error: 'Unclassified failure.',
  Error: 'Unexpected failure.',
  TypeError: 'Unexpected value type.',
  RangeError: 'Value outside its allowed range.',
  SyntaxError: 'Invalid syntax.',
  ReferenceError: 'Unavailable value.',
  AbortError: 'Operation cancelled.',
  Unauthenticated: 'Sign-in required.',
  Forbidden: 'Operation refused.',
  GrantDenied: 'Owner grant required.',
  NotFound: 'Requested item unavailable.',
  Conflict: 'State changed; refresh before retrying.',
  InvalidInput: 'Invalid input.',
  PayloadTooLarge: 'Input exceeds the size limit.',
  ResidentInactive: 'Resident authority inactive.',
  BudgetExhausted: 'Budget exhausted.',
  SubscriptionRequired: 'Subscription required.',
  NeedsAuthorization: 'Connection authorization required.',
  ScopeRequired: 'Connection needs more access.',
  UpstreamMcp: 'Remote MCP request failed.',
  Internal: 'Internal failure.',
  provider_error: 'Model provider failed.',
  invalid_arguments: 'Tool arguments did not match the input schema.',
  tool_unavailable: 'Tool unavailable.',
  tool_error: 'Tool failed.',
  blocked: 'Execution blocked.',
  capability_off: 'Capability disabled in this conversation.',
  not_in_topic: 'Not in the Topic setup.',
  interrupted: 'Execution interrupted.',
  aborted: 'Execution cancelled.',
  payment_refused: 'Payment from the Goblin Wallet refused.',
}
const UPSTREAM = new Set([
  'unauthorized',
  'remote-rpc',
  'transport',
  'timeout',
  'cancelled',
  'unsupported',
  'content-limit',
])

/**
 * Why the owner's Goblin Wallet did not pay a model call (ADR 0047), as `payment_refused:<code>`. Its own refusal codes
 * first, then goblin's (`mcp/inference-pay.ts`); another code is `payment_refused` alone. The words never come here.
 */
const PAYMENT = new Set([
  'insufficient_funds',
  'insufficient_scope',
  'above_max_usd',
  'above_service_cap',
  'rail_refused',
  'rail_unavailable',
  'payment_failed',
  'challenge_expired',
  'bad_challenge',
  'unknown_payee',
  'unexpected_recipient',
  'in_flight',
  'outcome_unknown',
  'operation_id_reused',
  'no_credential',
  'no_paying_wallet',
  'challenge_unreadable',
  'over_limit',
  'grant_denied',
  'ask_first',
  'wallet_signed_out',
  'wallet_unreachable',
  'refused_after_payment',
])

/** Payment refusals that wait on the owner (funds, a limit, a grant, a sign-in) rather than on goblin or the rail. */
const OWNER_PAYMENT = new Set([
  'insufficient_funds',
  'insufficient_scope',
  'above_max_usd',
  'above_service_cap',
  'no_paying_wallet',
  'over_limit',
  'grant_denied',
  'ask_first',
  'wallet_signed_out',
])

/** A wallet refusal's code as its telemetry code: `payment_refused:<code>` when known, else `payment_refused`. */
export const paymentRefusedCode = (code: string | undefined): string =>
  code !== undefined && PAYMENT.has(code) ? `payment_refused:${code}` : 'payment_refused'

/** A stored failure code: a known one stays, anything else is `error`. `outcomeOf` (attributes.ts) classifies a failure. */
export const safeFailureCode = (code: unknown): string => {
  if (typeof code !== 'string') return 'error'
  if (Object.hasOwn(FAILURES, code)) return code
  const [tag, reason] = code.split(':')
  if (reason === undefined || code !== `${tag}:${reason}`) return 'error'
  if (tag === 'UpstreamMcp' && UPSTREAM.has(reason)) return code
  return tag === 'payment_refused' && PAYMENT.has(reason) ? code : 'error'
}

export const failureSummary = (code: unknown): string => {
  const safe = safeFailureCode(code)
  if (safe.startsWith('UpstreamMcp:')) return `Remote MCP request failed (${safe.slice('UpstreamMcp:'.length)}).`
  if (safe.startsWith('payment_refused:'))
    return `Payment from the Goblin Wallet refused (${safe.slice('payment_refused:'.length)}).`
  return FAILURES[safe] ?? 'Unclassified failure.'
}

/** Expected owner decisions stay visible as blocked work, without becoming infrastructure warnings. */
export const expectedFailure = (code: unknown): boolean => {
  const safe = safeFailureCode(code)
  if (safe.startsWith('payment_refused:')) return OWNER_PAYMENT.has(safe.slice('payment_refused:'.length))
  return [
    'NeedsAuthorization',
    'ScopeRequired',
    'GrantDenied',
    'ResidentInactive',
    'BudgetExhausted',
    'SubscriptionRequired',
    'capability_off',
    'not_in_topic',
  ].includes(safe)
}

const ATTRIBUTES = new Set<string>(Object.values(RunAttribute))
const REASONS = new Set([
  'queued',
  'placed',
  'done',
  'unanswered',
  'model_error',
  'faulted',
  'failed',
  'aborted',
  'orphaned',
  'blocked',
  'closed',
  'cancelled',
  'expired',
  'stopped',
  'inactive',
  'unknown',
  'rejected',
  'unavailable',
  'lost',
])
const TOKENS = /^[A-Za-z0-9_.:/-]{1,160}$/u
const FINISH_REASONS = new Set(['stop', 'toolUse', 'length', 'error', 'aborted'])

const finiteText = (value: unknown, values: ReadonlySet<string>, fallback: string): string =>
  typeof value === 'string' && values.has(value) ? value : fallback

const ORIGINS = Schema.Literals(['owner', 'client', 'telegram', 'agent', 'routine', 'system'])
const COUNT = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
/** Flow attributes keep only a value of their closed set or id shape; anything else is dropped, never coerced. */
const FLOW_VALUES: Readonly<Record<string, (value: unknown) => boolean>> = {
  [RunAttribute.flow]: Schema.is(FlowName),
  [RunAttribute.flowVia]: Schema.is(FlowVia),
  [RunAttribute.flowStatus]: Schema.is(FlowStatus),
  [RunAttribute.actor]: Schema.is(FlowActor),
  [RunAttribute.origin]: Schema.is(ORIGINS),
  [RunAttribute.chat]: Schema.is(ChatId),
  [RunAttribute.parentChat]: Schema.is(ChatId),
  [RunAttribute.topic]: Schema.is(TopicId),
  [RunAttribute.parentOperation]: (value) => Schema.is(OperationId)(value) && TOKENS.test(value),
  [RunAttribute.count]: Schema.is(COUNT),
  [RunAttribute.personaOrder]: Schema.is(PersonaOrder),
  [RunAttribute.synthesize]: Schema.is(Schema.Boolean),
}

const scalarMetadata = (value: RunAttributes[string]): RunAttributes[string] | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  return TOKENS.test(value) && !value.includes('://') ? value : undefined
}

function safeAttribute(key: string, value: RunAttributes[string], attributes: RunAttributes) {
  const flowValue = FLOW_VALUES[key]
  if (flowValue !== undefined) return flowValue(value) ? value : undefined
  switch (key) {
    case RunAttribute.errorType:
      return safeFailureCode(value)
    case RunAttribute.error:
    case RunAttribute.blockedReason:
      return failureSummary(attributes[RunAttribute.errorType] ?? value)
    case RunAttribute.reason:
      return finiteText(value, REASONS, 'unknown')
    case RunAttribute.finishReason:
      return finiteText(value, FINISH_REASONS, 'error')
    case RunAttribute.compactionReason:
      return finiteText(value, new Set(['manual', 'auto', 'overflow']), 'unknown')
    default:
      return scalarMetadata(value)
  }
}

/** Defense at fan-out and on legacy reads: only known metadata fields and fixed failure summaries survive. */
export function sanitizeAttributes(attributes: RunAttributes): RunAttributes {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (!ATTRIBUTES.has(key)) return []
      const safe = safeAttribute(key, value, attributes)
      return safe === undefined ? [] : [[key, safe]]
    }),
  )
}
