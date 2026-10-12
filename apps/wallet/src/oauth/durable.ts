import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { LedgerHost } from '../ledger/durable.ts'
import { fromDurableObjectSql } from '../ledger/sql.ts'
import { SubscriptionStore } from '../merchant/store.ts'
import { OAuthStore } from './store.ts'

/** The store methods the Worker may call on the singleton, and nothing else. */
export const AUTH_METHODS = [
  'registerClient',
  'client',
  'openRequest',
  'viewRequest',
  'keepAlive',
  'returnOrigins',
  'decide',
  'exchangeCode',
  'refresh',
  'resolveAccess',
  'revokeToken',
  'connections',
  'disconnect',
  'revokeOwner',
] as const satisfies readonly (keyof OAuthStore)[]

/** The merchant subscriptions' methods (ADR 0054), served by the same singleton under `/subscriptions`. */
export const SUBSCRIPTION_METHODS = [
  'createSubscription',
  'merchantSubscription',
  'subscription',
  'viewSubscription',
  'putPrepared',
  'activate',
  'ownerSubscriptions',
  'putRevoke',
  'markRevoked',
  'beginCollection',
  'finishCollection',
] as const satisfies readonly (keyof SubscriptionStore)[]

/** A synchronous store as the Worker sees it over the Durable Object: the same methods, asynchronous. */
type Remote<Store, Method extends keyof Store> = {
  [K in Method]: Store[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never
}

/** The OAuth store as the Worker sees it. */
export type AuthApi = Remote<OAuthStore, (typeof AUTH_METHODS)[number]>
/** The subscription store as the Worker sees it. */
export type SubscriptionApi = Remote<SubscriptionStore, (typeof SUBSCRIPTION_METHODS)[number]>

const decodeEnvelope = (methods: readonly [string, ...string[]]) =>
  Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Struct({ method: Schema.Literals(methods), args: Schema.Array(Schema.Unknown) })),
  )
const decodeAuth = decodeEnvelope(AUTH_METHODS)
const decodeSubscription = decodeEnvelope(SUBSCRIPTION_METHODS)
const decodeReply = Schema.decodeUnknownOption(Schema.Struct({ result: Schema.optional(Schema.Unknown) }))

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/** One store's call: its method by name, applied to the arguments the typed client sent. */
const answer = (store: object, method: string, args: readonly unknown[]): Response => {
  // SAFETY: `method` is one of the store's own method names (decoded against its list), and the arguments come from
  // `storeClient`, typed by the store's Remote type as that method's own parameters.
  const call = (store as Record<string, (...input: unknown[]) => unknown>)[method]
  return call === undefined
    ? reply(404, { error: { code: 'not_found' } })
    : reply(200, { result: call.apply(store, [...args]) })
}

/**
 * The OAuth singleton (`idFromName('oauth')`): one SQLite holding every client, consent, code and token family, and
 * every merchant subscription with its collections. It answers `POST /rpc` (OAuth) and `POST /subscriptions` with
 * `{method, args}` → `{result}`; the stores are synchronous, so calls never interleave.
 */
export class WalletAuth implements DurableObject {
  readonly #store: OAuthStore
  readonly #subscriptions: SubscriptionStore

  constructor(ctx: LedgerHost) {
    const sql = fromDurableObjectSql(ctx.storage.sql, (write) => ctx.storage.transactionSync(write))
    this.#store = new OAuthStore(sql)
    this.#subscriptions = new SubscriptionStore(sql)
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method !== 'POST' || (path !== '/rpc' && path !== '/subscriptions'))
      return reply(404, { error: { code: 'not_found', message: 'The auth store answers POST /rpc only.' } })
    const text = await request.text()
    const envelope = Option.getOrUndefined(path === '/rpc' ? decodeAuth(text) : decodeSubscription(text))
    if (envelope === undefined) return reply(400, { error: { code: 'bad_call', message: 'Expected {method, args}.' } })
    return answer(path === '/rpc' ? this.#store : this.#subscriptions, envelope.method, envelope.args)
  }
}

type Calls = Record<string, (...args: unknown[]) => Promise<unknown>>

/** A client of one of the singleton's stores, over its stub (or, in tests, over a `WalletAuth` itself). */
const storeClient = (
  target: { fetch(request: Request): Promise<Response> },
  path: string,
  methods: readonly string[],
): Calls => {
  const call = async (method: string, args: readonly unknown[]): Promise<unknown> => {
    const response = await target.fetch(
      new Request(`https://auth.internal${path}`, { method: 'POST', body: JSON.stringify({ method, args }) }),
    )
    if (!response.ok) throw new Error(`auth_store: ${method} answered ${response.status}`)
    return Option.getOrUndefined(decodeReply(await response.json()))?.result
  }
  return Object.fromEntries(methods.map((name) => [name, (...args: unknown[]) => call(name, args)]))
}

/** The OAuth store's client over the singleton's stub (or, in tests, over a `WalletAuth` itself). */
export const authClient = (target: { fetch(request: Request): Promise<Response> }): AuthApi =>
  // SAFETY: each entry forwards to the OAuth store method of the same name, whose return type AuthApi names.
  storeClient(target, '/rpc', AUTH_METHODS) as AuthApi

/** The subscription store's client, over the same singleton. */
export const subscriptionClient = (target: { fetch(request: Request): Promise<Response> }): SubscriptionApi =>
  // SAFETY: each entry forwards to the subscription store method of the same name, whose return type it names.
  storeClient(target, '/subscriptions', SUBSCRIPTION_METHODS) as SubscriptionApi

const singleton = (namespace: DurableObjectNamespace) => namespace.get(namespace.idFromName('oauth'))

/** The singleton's OAuth client from the Worker's binding. */
export const authStore = (namespace: DurableObjectNamespace): AuthApi => authClient(singleton(namespace))

/** The singleton's subscription client from the Worker's binding. */
export const subscriptionStore = (namespace: DurableObjectNamespace): SubscriptionApi =>
  subscriptionClient(singleton(namespace))
