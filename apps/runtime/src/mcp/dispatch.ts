import type { RequestOptions } from '@modelcontextprotocol/client'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import { type AppError, Forbidden } from '../http/errors.ts'
import { promiseWith } from '../runtime/boundary.ts'

const HEADER = 'x-goblin-local-dispatch'
function headersOf(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  const incoming = init?.headers
  if (incoming instanceof Headers) incoming.forEach((value, key) => headers.set(key, value))
  else if (incoming !== undefined && Symbol.iterator in incoming)
    for (const tuple of incoming) {
      const [key, value] = [...tuple]
      if (typeof key === 'string' && typeof value === 'string') headers.set(key, value)
    }
  else if (incoming !== undefined)
    for (const [key, value] of Object.entries(incoming)) if (typeof value === 'string') headers.set(key, value)
  return headers
}

/**
 * Runs a request's guard from inside the SDK's transport fetch: the guard is an Effect bound to its caller's services,
 * and its typed `AppError` rejects the fetch as itself, which the SDK passes through.
 */
const guarded = promiseWith(Context.empty())

/**
 * Per-request guards that survive SDK OAuth retries: each HTTP dispatch of a request runs its guard first. The local
 * correlation header never leaves the Worker.
 */
export class DispatchGuards {
  readonly #guards = new Map<string, Effect.Effect<void, AppError>>()

  /** Sends one SDK request whose every HTTP dispatch first passes `guard`. */
  async request<A>(
    guard: Effect.Effect<void, AppError>,
    options: RequestOptions,
    send: (options: RequestOptions) => Promise<A>,
  ): Promise<A> {
    const id = crypto.randomUUID()
    this.#guards.set(id, guard)
    try {
      return await send({ ...options, headers: { ...options.headers, [HEADER]: id } })
    } finally {
      this.#guards.delete(id)
    }
  }

  /** The transport's fetch: a request's guard runs before each of its dispatches, and its header is removed. */
  async fetch(input: RequestInfo | URL, init: RequestInit | undefined, send: typeof fetch): Promise<Response> {
    const headers = headersOf(input, init)
    const id = headers.get(HEADER)
    if (id !== null) {
      const guard = this.#guards.get(id)
      if (guard === undefined) throw new Forbidden({ reason: 'MCP dispatch has expired' })
      await guarded(guard)
      headers.delete(HEADER)
    }
    return send(input, { ...init, headers })
  }
}
