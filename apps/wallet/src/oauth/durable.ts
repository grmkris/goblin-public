import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { LedgerHost } from '../ledger/durable.ts'
import { fromDurableObjectSql } from '../ledger/sql.ts'
import { OAuthStore } from './store.ts'

/** The store methods the Worker may call on the singleton, and nothing else. */
export const AUTH_METHODS = [
  'registerClient',
  'client',
  'openRequest',
  'pendingRequest',
  'decide',
  'exchangeCode',
  'refresh',
  'resolveAccess',
  'revokeToken',
  'connections',
  'disconnect',
  'revokeOwner',
] as const satisfies readonly (keyof OAuthStore)[]

type AuthMethod = (typeof AUTH_METHODS)[number]

/** The OAuth store as the Worker sees it: the same methods, over the Durable Object, asynchronous. */
export type AuthApi = {
  [K in AuthMethod]: OAuthStore[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never
}

const Envelope = Schema.Struct({ method: Schema.Literals(AUTH_METHODS), args: Schema.Array(Schema.Unknown) })
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))
const decodeReply = Schema.decodeUnknownOption(Schema.Struct({ result: Schema.optional(Schema.Unknown) }))

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/**
 * The OAuth singleton (`idFromName('oauth')`): one SQLite holding every client, consent, code and token family. It
 * answers `POST /rpc {method, args}` with `{result}`; the store is synchronous, so calls never interleave.
 */
export class WalletAuth implements DurableObject {
  readonly #store: OAuthStore

  constructor(ctx: LedgerHost) {
    this.#store = new OAuthStore(fromDurableObjectSql(ctx.storage.sql, (write) => ctx.storage.transactionSync(write)))
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/rpc')
      return reply(404, { error: { code: 'not_found', message: 'The auth store answers POST /rpc only.' } })
    const envelope = Option.getOrUndefined(decodeEnvelope(await request.text()))
    if (envelope === undefined) return reply(400, { error: { code: 'bad_call', message: 'Expected {method, args}.' } })
    // SAFETY: the name is one of AUTH_METHODS (decoded above), and the arguments come from `authClient`, typed by
    // AuthApi as that method's own parameters.
    const method = this.#store[envelope.method] as (...args: unknown[]) => unknown
    return reply(200, { result: method.apply(this.#store, [...envelope.args]) })
  }
}

/** A typed client over the singleton's stub (or, in tests, over a `WalletAuth` itself). */
export const authClient = (target: { fetch(request: Request): Promise<Response> }): AuthApi => {
  const call = async (method: AuthMethod, args: readonly unknown[]): Promise<unknown> => {
    const response = await target.fetch(
      new Request('https://auth.internal/rpc', { method: 'POST', body: JSON.stringify({ method, args }) }),
    )
    if (!response.ok) throw new Error(`auth_store: ${method} answered ${response.status}`)
    return Option.getOrUndefined(decodeReply(await response.json()))?.result
  }
  // SAFETY: each entry forwards to the WalletAuth store method of the same name, whose return type AuthApi names.
  return Object.fromEntries(AUTH_METHODS.map((name) => [name, (...args: unknown[]) => call(name, args)])) as AuthApi
}

/** The singleton's client from the Worker's binding. */
export const authStore = (namespace: DurableObjectNamespace): AuthApi =>
  authClient(namespace.get(namespace.idFromName('oauth')))
