import { Schema } from 'effect'
import type { JsonValue } from '@goblin/contracts'
import { ERROR_COPY } from '@goblin/contracts/api'
import { describeError } from './query/app-error.ts'

const ObjectSchema = Schema.Record(Schema.String, Schema.Unknown)
export const isString = Schema.is(Schema.String)
export const isNumber = Schema.is(Schema.Number)
export function record(value: unknown): Record<string, unknown> | undefined {
  return Schema.is(ObjectSchema)(value) ? value : undefined
}
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        const parsed = record(item)
        return parsed ? [parsed] : []
      })
    : []
}
export function text(value: unknown): string {
  if (isString(value)) return value
  return records(value)
    .filter((part) => part.type === 'text')
    .map((part) => (isString(part.text) ? part.text : ''))
    .join('\n')
}
export function identifier(value: unknown): string {
  return isString(value) || isNumber(value) ? String(value) : ''
}
export type RequestOptions = {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly body?: unknown
  readonly signal?: AbortSignal
  readonly headers?: Record<string, string>
}
/** Where a failure can be found again: what the owner quotes, and the ids the request went out with. */
export interface FailureTrace {
  /** The edge's reference (its cf-ray) when an answer came back, else the request's own id. */
  readonly ref?: string | undefined
  /** The id this request was sent with (`x-goblin-request`). */
  readonly request?: string | undefined
  /** The operation a write ran as (`x-goblin-operation`), when it named one. */
  readonly operation?: string | undefined
  /** The answer's fixed public copy, for a code this page has no words of its own for. */
  readonly copy?: string | undefined
}
/** A failed API call: the runtime's error tag (`GrantDenied`, `NeedsAuthorization`, ...) and HTTP status. */
export class ApiFailure extends Error {
  readonly tag: string
  readonly status: number
  /** The safe detail the runtime gives for some failures (`InvalidInput`'s reason, for example). */
  readonly reason: string | undefined
  readonly ref: string | undefined
  readonly request: string | undefined
  readonly operation: string | undefined
  readonly copy: string | undefined
  constructor(tag: string, status: number, reason?: string, trace: FailureTrace = {}) {
    super(tag)
    this.tag = tag
    this.status = status
    this.reason = reason
    this.ref = trace.ref
    this.request = trace.request
    this.operation = trace.operation
    this.copy = trace.copy
  }
}
/** A short id for one request: what a failure quotes when no answer came back. */
const requestId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 8)
/** The tag of each error envelope code (`not_found` is `NotFound`); a code with no tag (`billing_unavailable`) stays. */
const TAG_OF_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(ERROR_COPY).map(([tag, copy]) => [copy.code, tag]),
)
/**
 * What a failure body says, in either shape the API answers: the error envelope `{ error: { code, message, … } }` of
 * the typed API, or the older `{ error: Tag, …fields }`.
 */
function failureOf(data: JsonValue): { tag?: string; reason?: string; ref?: string; copy?: string } {
  const body = record(data)
  const envelope = record(body?.error)
  if (envelope === undefined)
    return {
      ...(isString(body?.error) ? { tag: body.error } : {}),
      ...(isString(body?.reason) ? { reason: body.reason } : {}),
    }
  const { code, reason, ref, message, recovery } = envelope
  return {
    ...(isString(code) ? { tag: TAG_OF_CODE.get(code) ?? code } : {}),
    ...(isString(reason) ? { reason } : {}),
    ...(isString(ref) ? { ref } : {}),
    ...(isString(message) ? { copy: isString(recovery) ? `${message} ${recovery}` : message } : {}),
  }
}
/** Same-origin JSON call with the owner's cookie. Non-JSON error bodies still produce an `ApiFailure`. */
export async function request(path: string, options: RequestOptions = {}): Promise<JsonValue> {
  const { method = options.body === undefined ? 'GET' : 'POST', body, signal, headers } = options
  const sent = requestId()
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-goblin-request': sent,
      ...(method === 'GET' ? {} : { 'x-goblin-csrf': '1' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  })
  const trace = {
    ref: response.headers.get('x-goblin-ref') ?? sent,
    request: sent,
    operation: headers?.['x-goblin-operation'],
  }
  let data: JsonValue = null
  try {
    data = Schema.decodeUnknownSync(Schema.MutableJson)(await response.json())
  } catch {
    // expected: a body that is not JSON; a failed answer is still classified by its status below.
    if (response.ok) throw new ApiFailure('InvalidResponse', response.status, undefined, trace)
  }
  if (!response.ok) {
    const { tag, reason, ref, copy } = failureOf(data)
    throw new ApiFailure(tag ?? `HTTP ${response.status}`, response.status, reason, {
      ...trace,
      ref: ref ?? trace.ref,
      copy,
    })
  }
  return data
}

/** Plain-language text for an API failure, for alerts, ending with the reference to quote ("… · ref 7f3a9c12"). */
export function failureText(error: unknown): string {
  if (!(error instanceof ApiFailure)) {
    // A typed client's failure (an AppError, a billing refusal) reads in its contract copy, never its exception text.
    const view = describeError(error)
    if (view.message === undefined) return error instanceof Error ? error.message : 'Something went wrong'
    const words = view.recovery === undefined ? view.message : `${view.message} ${view.recovery}`
    return view.ref === undefined ? words : `${words} · ref ${view.ref.slice(0, 8)}`
  }
  const known: Record<string, string> = {
    SubscriptionRequired: 'Subscribe to Pro to use your personal agent.',
    billing_unavailable: 'Checkout is being set up. Please try again later.',
    Unauthenticated: 'Your session has ended. Sign in again.',
    GrantDenied: 'That tool is not enabled. Turn it on under Connections.',
    NeedsAuthorization: 'This server needs to be connected again.',
    ResidentInactive: 'Resident authority is off. Re-enable it in Settings.',
    BudgetExhausted: "You have used today's model budget. It resets at 00:00 UTC.",
    UpstreamMcp: 'The MCP server did not respond as expected.',
    NotFound: 'Not found.',
    InvalidInput: 'The request was not valid.',
    PayloadTooLarge: 'That is more than your storage takes: 25 MB a file, 512 MB in all.',
  }
  const words = known[error.tag] ?? error.copy ?? `Request failed (${error.tag})`
  return error.ref === undefined ? words : `${words} · ref ${error.ref.slice(0, 8)}`
}
