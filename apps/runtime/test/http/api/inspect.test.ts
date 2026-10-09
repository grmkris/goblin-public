import { InspectGroup, SubscriptionRequired, ownerApiOf } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { afterEach, describe, expect, it } from 'vitest'
import { Entitlements } from '../../../src/billing/gates.ts'
import type { AccountPlan } from '../../../src/billing/reconcile.ts'
import { OwnerGateLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { InspectHandlers } from '../../../src/inspect/api.ts'
import { ResidentAuthority } from '../../../src/resident.ts'
import { Resident } from '../../../src/services.ts'
import { callOwner } from '../../integration/owner-api.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 100,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** Resident authority that only counts renewals: the gate renews it on every admitted request. */
class CountingResident extends ResidentAuthority {
  readonly renewals: number[] = []
  constructor() {
    // SAFETY: `renew` is overridden below and nothing else is called, so the database is never touched.
    super(undefined as never)
  }
  override renew(now: number): void {
    this.renewals.push(now)
  }
}

/** Only the inspect group, behind the real gate, router and failure rendering. */
const INSPECT_API = ownerApiOf(InspectGroup)
const INSPECT = HttpApiBuilder.layer(INSPECT_API).pipe(
  Layer.provide(InspectHandlers),
  Layer.provide(OwnerGateLive),
  Layer.provide(HttpServer.layerServices),
)

const runtimes: ManagedRuntime.ManagedRuntime<OwnerHttp, never>[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

/** The inspect group as the agent serves it. Its handlers read no service; the gate's plan and authority are fakes. */
const fixture = (options: { readonly active?: boolean } = {}) => {
  const resident = new CountingResident()
  const plan = Effect.succeed({ ...PLAN, active: options.active ?? true })
  const runtime = ManagedRuntime.make(
    OwnerHttp.serve(INSPECT_API, INSPECT).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Resident, resident),
          Layer.succeed(Entitlements, {
            state: () => plan,
            require: () =>
              Effect.flatMap(plan, (current) =>
                current.active
                  ? Effect.succeed(current)
                  : Effect.fail(new SubscriptionRequired({ subscribe: '/subscribe' })),
              ),
          }),
        ),
      ),
    ),
  )
  runtimes.push(runtime)
  /** The agent's answer, or a failure if the server passed the request on. */
  const fetch = async (request: Request) =>
    Option.getOrThrowWith(
      await runtime.runPromise(OwnerHttp.use((http) => http.handle(request))),
      () => new Error(`not an API route: ${request.url}`),
    )
  return { fetch, resident }
}

const get = (path: string) => new Request(`https://agent${path}`, { headers: { 'x-goblin-ref': 'ref-1' } })

describe('the inspect group served by the agent', () => {
  it("answers a message's details by operation or entry; none are found until the receipts are read", async () => {
    const { fetch, resident } = fixture()
    for (const query of ['operation=owner%3Aop-1', 'entry=40']) {
      const response = await fetch(get(`/api/conversations/12/details?${query}`))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: { code: 'not_found', message: 'That does not exist.', what: 'details', ref: 'ref-1' },
      })
    }
    expect(resident.renewals).toHaveLength(2)
  })

  it('refuses a query naming neither an operation nor an entry (400), and a chat id that is not one (404)', async () => {
    const { fetch } = fixture()
    for (const query of ['', '?entry=0', '?entry=forty', '?chat=12'])
      expect(await (await fetch(get(`/api/conversations/12/details${query}`))).json()).toMatchObject({
        error: { code: 'invalid_input', reason: 'query does not match the expected shape' },
      })
    const route = await fetch(get('/api/conversations/main/details?operation=op-1'))
    expect(route.status).toBe(404)
    expect(await route.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
  })

  it('answers 402 from the gate before the handler runs', async () => {
    const { fetch, resident } = fixture({ active: false })
    const response = await fetch(get('/api/conversations/12/details?operation=op-1'))
    expect(response.status).toBe(402)
    expect(resident.renewals).toEqual([])
  })

  it("serves the probes' typed client, which decodes the refusal as the NotFound class", async () => {
    const { fetch } = fixture()
    const refused = await callOwner({ fetch }, (api) =>
      Effect.flip(api.inspect.details({ params: { id: '12' }, query: { entry: 40 } })),
    )
    expect(refused).toMatchObject({ _tag: 'NotFound', what: 'details', ref: 'integration-probe' })
  })
})
