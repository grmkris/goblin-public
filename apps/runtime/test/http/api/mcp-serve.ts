import { SubscriptionRequired } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import { afterEach } from 'vitest'
import { Entitlements, type EntitlementPolicy } from '../../../src/billing/gates.ts'
import type { AccountPlan } from '../../../src/billing/reconcile.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { Db } from '../../../src/runtime/db.ts'
import type { chatDatabase } from '../../chats-sqlite.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 100,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** The account's plan as the owner gate reads it: active, or not. */
export const plans = (active = true): Layer.Layer<Entitlements> => {
  const plan = Effect.succeed({ ...PLAN, active })
  const policy: EntitlementPolicy = {
    state: () => plan,
    require: () =>
      Effect.flatMap(plan, (current) =>
        current.active ? Effect.succeed(current) : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })),
      ),
  }
  return Layer.succeed(Entitlements, policy)
}

const runtimes: ManagedRuntime.ManagedRuntime<OwnerHttp, never>[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

/**
 * Requests answered through `http`: one area's groups served the way the agent serves the owner API
 * (`OwnerHttp.serve`), with the services they read already provided. Disposed after each test.
 */
export const serve = (http: Layer.Layer<OwnerHttp>) => {
  const runtime = ManagedRuntime.make(http)
  runtimes.push(runtime)
  const handle = (request: Request) => runtime.runPromise(OwnerHttp.use((owner) => owner.handle(request)))
  /** The agent's answer, or a failure if the server passed the request on to its raw routes. */
  const fetch = async (request: Request) =>
    Option.getOrThrowWith(await handle(request), () => new Error(`not an API route: ${request.url}`))
  return { handle, fetch }
}

/**
 * A service with only `parts` implemented, for a test whose requests reach only those: any other method dies when it
 * is called, which the test sees as a 500.
 */
export const partial = <S extends object>(parts: Partial<S>): S =>
  // SAFETY: the methods `parts` leaves out are never called by the requests of the test that builds it; each one that is
  // called anyway dies with its name instead of returning undefined.
  new Proxy(parts, {
    get: (target, key) => {
      if (key in target) {
        // SAFETY: `key in target` holds, so it names one of the parts the test implemented.
        return target[key as keyof S]
      }
      // Symbols and `then` are how runtimes probe an object; only a method the test left out dies when called.
      if (typeof key === 'symbol' || key === 'then') return undefined
      return () => Effect.die(new Error(`not in this fixture: ${key}`))
    },
  }) as S

/** The agent's database (`Db`) over a node:sqlite one with the application migrations applied (chats-sqlite.ts). */
export const sqliteDb = (db: ReturnType<typeof chatDatabase>['db']): Layer.Layer<Db> =>
  // SAFETY: the services under test use only Drizzle's synchronous query builder, which both drivers share.
  Layer.succeed(Db, db as never)

/** A JSON request to the agent, as the Worker edge forwards one. */
export const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://agent${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
