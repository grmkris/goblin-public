import { Schema } from 'effect'
import type { JsonValue } from '@purrable/contracts'

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
/** A failed API call: the runtime's error tag (`GrantDenied`, `NeedsAuthorization`, ...) and HTTP status. */
export class ApiFailure extends Error {
  readonly tag: string
  readonly status: number
  /** The safe detail the runtime gives for some failures (`InvalidInput`'s reason, for example). */
  readonly reason: string | undefined
  constructor(tag: string, status: number, reason?: string) {
    super(tag)
    this.tag = tag
    this.status = status
    this.reason = reason
  }
}
/** Same-origin JSON call with the owner's cookie. Non-JSON error bodies still produce an `ApiFailure`. */
export async function request(path: string, options: RequestOptions = {}): Promise<JsonValue> {
  const { method = options.body === undefined ? 'GET' : 'POST', body, signal, headers } = options
  // @effect-diagnostics-next-line globalFetch:off -- Browser UI owns this same-origin authenticated request boundary; runtime Effect services cannot access the browser session.
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method === 'GET' ? {} : { 'x-purrable-csrf': '1' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  })
  let data: JsonValue = null
  try {
    data = Schema.decodeUnknownSync(Schema.MutableJson)(await response.json())
  } catch {
    if (response.ok) throw new ApiFailure('InvalidResponse', response.status)
  }
  if (!response.ok) {
    const tag = record(data)?.error
    const reason = record(data)?.reason
    throw new ApiFailure(
      isString(tag) ? tag : `HTTP ${response.status}`,
      response.status,
      isString(reason) ? reason : undefined,
    )
  }
  return data
}

/** Plain-language text for an API failure, for alerts. */
export function failureText(error: unknown): string {
  if (!(error instanceof ApiFailure)) return error instanceof Error ? error.message : 'Something went wrong'
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
  }
  return known[error.tag] ?? `Request failed (${error.tag})`
}
