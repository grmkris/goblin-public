import { SubscriptionRequired, ownerApiOf } from '@goblin/contracts/api'
import type { NonEmptyReadonlyArray } from 'effect/Array'
import type * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Schema from 'effect/Schema'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { afterEach } from 'vitest'
import { Entitlements, type EntitlementPolicy } from '../../../src/billing/gates.ts'
import type { AccountPlan } from '../../../src/billing/reconcile.ts'
import { OwnerAdmissionLive } from '../../../src/http/api/middleware.ts'
import { routeNames } from '../../../src/http/api/context.ts'
import { AgentHttp } from '../../../src/http/api/server.ts'
import { chatDatabase } from '../../chats-sqlite.ts'

export { currentResident } from '../../fixed-services.ts'
export { type ChatDatabase as Database, sqliteDb } from '../../chats-sqlite.ts'

/** The account's plan in these tests: an active override with 100 Credits a day. */
export const PLAN: AccountPlan = {
  active: true,
  plan: 'pro',
  source: 'override',
  billing: null,
  until: null,
  dailyCredits: 100,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** The account's plan as owner admission reads it (`Entitlements`): active, or refused as `SubscriptionRequired`. */
export const plans = (active = true): Layer.Layer<Entitlements> => {
  const plan = Effect.succeed({ ...PLAN, active })
  const policy: EntitlementPolicy = {
    state: () => plan,
    require: () =>
      Effect.flatMap(plan, (current) =>
        current.active
          ? Effect.succeed(current)
          : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe', feature: 'chat' })),
      ),
    payDay: () => Effect.succeed('settled'),
  }
  return Layer.succeed(Entitlements, policy)
}

/**
 * `groups` and their `handlers` served the way the agent serves the owner API (`AgentHttp.serve`): behind owner
 * admission, its router and its failure rendering. Provide it the services the handlers read, then `serve` it.
 */
export const served = <const Groups extends NonEmptyReadonlyArray<HttpApiGroup.Constraint>, Handlers, R>(
  groups: Groups,
  handlers: Layer.Layer<Handlers, never, R>,
) => {
  const api = ownerApiOf(...groups)
  return AgentHttp.serve(
    [routeNames(api)],
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(handlers),
      Layer.provide(OwnerAdmissionLive),
      Layer.provide(HttpServer.layerServices),
    ),
  )
}

const disposals: (() => unknown)[] = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).toReversed()) await dispose()
})

/** Runs `dispose` after the test, after anything registered later (last in, first out). */
export const cleanup = (dispose: () => unknown): void => void disposals.push(dispose)

/** Requests answered through `http`, as the agent answers them; disposed after each test. */
export const serve = (http: Layer.Layer<AgentHttp>) => {
  const runtime = ManagedRuntime.make(http)
  cleanup(() => runtime.dispose())
  const fetch = (request: Request) => runtime.runPromise(AgentHttp.use((agent) => agent.handle(request)))
  return { fetch }
}

const Unrouted = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal('not_found'), what: Schema.Literal('route') }),
})

/** Whether `response` is the agent's answer to a path that names none of its endpoints. */
export const unrouted = async (response: Response): Promise<boolean> =>
  response.status === 404 && Schema.is(Unrouted)(await response.json())

/** A node:sqlite database with the application migrations applied (chats-sqlite.ts), closed after each test. */
export const database = () => {
  const { db, close } = chatDatabase()
  cleanup(close)
  return db
}

/**
 * `tag`'s service with only `parts` (`Layer.mock`): any member they leave out dies when it is used, naming the service
 * and the member. With no parts it is a service the test never uses.
 */
export const stub = <I, S extends object>(tag: Context.Key<I, S>, parts: Partial<S> = {}): Layer.Layer<I> =>
  // SAFETY: Layer.mock answers every member `parts` leaves out, data members included, with a value that dies when used.
  Layer.mock(tag, parts as Layer.PartialEffectful<S>)

/** A request to the agent's owner API, as the Worker's edge forwards one; a body is sent as JSON. */
export const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://agent${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })

/** A GET of `path`. */
export const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://agent${path}`, { headers })

/** A POST of `body` to `path`. */
export const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  json('POST', path, body, headers)
