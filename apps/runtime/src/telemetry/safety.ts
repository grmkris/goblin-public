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
import * as Option from 'effect/Option'
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
  UpstreamMcp: 'Remote MCP request failed.',
  Internal: 'Internal failure.',
  provider_error: 'Model provider failed.',
  invalid_arguments: 'Tool arguments did not match the input schema.',
  tool_unavailable: 'Tool unavailable.',
  tool_error: 'Tool failed.',
  blocked: 'Execution blocked.',
  capability_off: 'Capability disabled in this conversation.',
  interrupted: 'Execution interrupted.',
  aborted: 'Execution cancelled.',
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
const Tagged = Schema.Struct({ _tag: Schema.String, reason: Schema.optional(Schema.String) })

/** Unknown classes, reasons and remote text collapse to a stable code. Never use message, stack or cause. */
export function safeErrorType(error: unknown): string {
  const tagged = Schema.decodeUnknownOption(Tagged)(error)
  if (Option.isSome(tagged)) {
    const { _tag: tag, reason } = tagged.value
    if (tag === 'UpstreamMcp' && reason !== undefined && UPSTREAM.has(reason)) return `${tag}:${reason}`
    return Object.hasOwn(FAILURES, tag) ? tag : 'error'
  }
  return error instanceof Error && Object.hasOwn(FAILURES, error.name) ? error.name : 'error'
}

export const safeFailureCode = (code: unknown): string => {
  if (typeof code !== 'string') return 'error'
  if (Object.hasOwn(FAILURES, code)) return code
  const [tag, reason] = code.split(':')
  return tag === 'UpstreamMcp' && reason !== undefined && UPSTREAM.has(reason) && code === `${tag}:${reason}`
    ? code
    : 'error'
}

export const failureSummary = (code: unknown): string => {
  const safe = safeFailureCode(code)
  if (safe.startsWith('UpstreamMcp:')) return `Remote MCP request failed (${safe.slice('UpstreamMcp:'.length)}).`
  return FAILURES[safe] ?? 'Unclassified failure.'
}

/** Expected owner decisions stay visible as blocked work, without becoming infrastructure warnings. */
export const expectedFailure = (code: unknown): boolean =>
  [
    'NeedsAuthorization',
    'GrantDenied',
    'ResidentInactive',
    'BudgetExhausted',
    'SubscriptionRequired',
    'capability_off',
  ].includes(safeFailureCode(code))

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
