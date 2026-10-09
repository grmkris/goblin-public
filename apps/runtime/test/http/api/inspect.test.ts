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
import { Resident } from '../../../src/mcp/service.ts'
import { flowRunEvent } from '../../../src/telemetry/events.ts'
import { currentResident } from '../../fixed-services.ts'
import { callOwner } from '../../integration/owner-api.ts'
import { inspectionFixture } from '../../inspection-fixture.ts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 100,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}

/** Only the inspect group, behind the real gate, router and failure rendering. */
const INSPECT_API = ownerApiOf(InspectGroup)
const INSPECT = HttpApiBuilder.layer(INSPECT_API).pipe(
  Layer.provide(InspectHandlers),
  Layer.provide(OwnerGateLive),
  Layer.provide(HttpServer.layerServices),
)

const runtimes: ManagedRuntime.ManagedRuntime<OwnerHttp, never>[] = []
const closes: (() => void)[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const close of closes.splice(0)) close()
})

/**
 * The inspect group as the agent serves it, over inspection of a real ledger (`inspectionFixture`: chat `12` is Pi
 * session `40`). The gate's plan and resident authority are the only fakes.
 */
const fixture = (options: { readonly active?: boolean } = {}) => {
  const resident = currentResident()
  const plan = Effect.succeed({ ...PLAN, active: options.active ?? true })
  const inspection = inspectionFixture()
  closes.push(inspection.close)
  const runtime = ManagedRuntime.make(
    OwnerHttp.serve(INSPECT_API, INSPECT).pipe(
      Layer.provide(
        Layer.mergeAll(
          inspection.layer,
          Layer.succeed(Resident, resident.service),
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
  return { fetch, resident, ledger: inspection.ledger }
}

/** A move from chat 12 into a new thread, recorded as its one flow step, and the answer of a turn there. */
const move = flowRunEvent(
  { flow: 'move', via: 'app', actor: 'owner', chat: '12', operationId: 'owner:op-9', status: 'ok' },
  'flow:1',
  1_000,
)
const answer = {
  id: 'model:t1:1:0',
  kind: 'model.attempt' as const,
  status: 'ok' as const,
  conversationId: '40',
  operationId: 'owner:op-8',
  taskId: 't1',
  startedAt: 900,
  endedAt: 950,
  attributes: { 'goblin.entry': 40 },
}

const get = (path: string) => new Request(`https://agent${path}`, { headers: { 'x-goblin-ref': 'ref-1' } })

describe('the inspect group served by the agent', () => {
  it("answers a message's details by its operation or by its entry, and 404 for one it has none of", async () => {
    const { fetch, resident, ledger } = fixture()
    ledger.ended(move)
    ledger.ended(answer)
    const byOperation = await fetch(get('/api/conversations/12/details?operation=owner%3Aop-9'))
    expect(byOperation.status).toBe(200)
    expect(await byOperation.json()).toEqual({
      events: [move],
      coverage: { complete: true, gaps: [] },
      related: [],
    })
    const byEntry = await fetch(get('/api/conversations/12/details?entry=40'))
    expect(await byEntry.json()).toMatchObject({ events: [{ operationId: 'owner:op-8' }], related: [] })
    const missing = await fetch(get('/api/conversations/12/details?entry=41'))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: { code: 'not_found', message: 'That does not exist.', what: 'entry operation', ref: 'ref-1' },
    })
    expect(resident.renewals).toHaveLength(3)
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

  it("serves the probes' typed client: details decode, and a refusal decodes as the NotFound class", async () => {
    const { fetch, ledger } = fixture()
    ledger.ended(move)
    const details = await callOwner({ fetch }, (api) =>
      api.inspect.details({ params: { id: '12' }, query: { operation: 'owner:op-9' } }),
    )
    expect(details.events.map((event) => event.id)).toEqual(['flow:1'])
    const refused = await callOwner({ fetch }, (api) =>
      Effect.flip(api.inspect.details({ params: { id: '12' }, query: { entry: 40 } })),
    )
    expect(refused).toMatchObject({ _tag: 'NotFound', what: 'entry operation', ref: 'integration-probe' })
  })
})
