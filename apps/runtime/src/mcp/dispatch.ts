import type { RequestOptions } from '@modelcontextprotocol/client'
import { Forbidden } from '../http/errors.ts'

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

/** Per-request guards survive SDK OAuth retries; the local correlation header never leaves the Worker. */
export class DispatchGuards {
  readonly #guards = new Map<string, () => void | Promise<void>>()

  async request<A>(
    authorize: () => void | Promise<void>,
    options: RequestOptions,
    send: (options: RequestOptions) => Promise<A>,
  ): Promise<A> {
    const id = crypto.randomUUID()
    this.#guards.set(id, authorize)
    try {
      return await send({ ...options, headers: { ...options.headers, [HEADER]: id } })
    } finally {
      this.#guards.delete(id)
    }
  }

  async fetch(input: RequestInfo | URL, init: RequestInit | undefined, send: typeof fetch): Promise<Response> {
    const headers = headersOf(input, init)
    const id = headers.get(HEADER)
    if (id !== null) {
      const guard = this.#guards.get(id)
      if (guard === undefined) throw new Forbidden({ reason: 'MCP dispatch has expired' })
      await guard()
      headers.delete(HEADER)
    }
    return send(input, { ...init, headers })
  }
}
