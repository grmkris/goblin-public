import type { RoutineDefinition, RoutineManualRun } from '@goblin/contracts'
import { RoutinePage, RoutineRunView, RoutineView } from '@goblin/contracts'
import { RoutinesGroup, ownerApiOf } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'
import { Entitlements, type EntitlementPolicy } from '../../../src/billing/gates.ts'
import type { AccountPlan } from '../../../src/billing/reconcile.ts'
import { OwnerAdmissionLive } from '../../../src/http/api/middleware.ts'
import { OwnerHttp } from '../../../src/http/api/server.ts'
import { Resident } from '../../../src/mcp/service.ts'
import { RoutinesHandlers } from '../../../src/routines/api.ts'
import { ModelBudgetLive } from '../../../src/layers/budget.ts'
import { RoutinesLive } from '../../../src/layers/routines.ts'
import { RoutineController } from '../../../src/routines/controller.ts'
import { RoutineRunStore } from '../../../src/routines/runs.ts'
import { RoutineStore } from '../../../src/routines/store.ts'
import { Db } from '../../../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../../../src/runtime/input.ts'
import { chatDatabase } from '../../chats-sqlite.ts'
import { currentResident } from '../../fixed-services.ts'
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

const DEFINITION: RoutineDefinition = {
  title: 'Plants',
  prompt: 'Remind me to water the plants.',
  trigger: { kind: 'cron', expression: '0 9 * * *' },
  timezone: 'UTC',
  notifyTelegram: false,
  allowedTools: [],
  budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
}

/** Only this group, behind the real gate, router and failure rendering. */
const API = ownerApiOf(RoutinesGroup)
const SERVED = HttpApiBuilder.layer(API).pipe(
  Layer.provide(RoutinesHandlers),
  Layer.provide(OwnerAdmissionLive),
  Layer.provide(HttpServer.layerServices),
)

const runtimes: ManagedRuntime.ManagedRuntime<OwnerHttp, never>[] = []
const closes: (() => void)[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const close of closes.splice(0)) close()
})

/**
 * The routines group as the agent serves it, over the real routine stores on SQLite and the lane's adapters. The routine
 * controller is the one fake: it records what the runtime asked of it, and "run now" claims the run in the real store.
 */
const fixture = () => {
  const { db, close } = chatDatabase()
  closes.push(close)
  // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
  const sqlite = db as never
  const routines = new RoutineStore(sqlite, 'owner')
  const runs = new RoutineRunStore(sqlite, 'owner')
  const calls: string[] = []
  const controller: RoutineController = Object.assign(Object.create(RoutineController.prototype), {
    reconcile: async () => void calls.push('reconcile'),
    confirmEvents: async (id: string, revision: number) => void calls.push(`confirmEvents ${id} ${revision}`),
    archive: async (id: string) => void calls.push(`archive ${id}`),
    manual: async (id: string, input: RoutineManualRun) => {
      calls.push(`manual ${id}`)
      const firing = {
        routineId: id,
        revision: input.revision,
        operationId: `routine-manual:${id}:${input.operationId}`,
        source: 'manual' as const,
        firedAt: 1,
      }
      return runs.claim(firing, 'rr_1', undefined, Date.now()).run
    },
  })
  const plans: EntitlementPolicy = { state: () => Effect.succeed(PLAN), require: () => Effect.succeed(PLAN) }
  const resident = currentResident()
  const legacy = Layer.mergeAll(
    Layer.succeed(Db, sqlite),
    // The gate's resident authority and plan.
    Layer.succeed(Resident, resident.service),
    Layer.succeed(Entitlements, plans),
    // SAFETY: the routines handlers and the lane's layers read only these from the instance input.
    Layer.succeed(AgentInput, {
      routines: controller,
      entitlements: plans,
      userId: 'owner',
      env: { MODEL_ID: 'model-a' },
    } as AgentInputs),
  )
  const runtime = ManagedRuntime.make(
    OwnerHttp.serve(API, SERVED).pipe(
      Layer.provide(Layer.provideMerge(Layer.merge(ModelBudgetLive, RoutinesLive), legacy)),
    ),
  )
  runtimes.push(runtime)
  const fetch = async (request: Request) =>
    Option.getOrThrowWith(await runtime.runPromise(OwnerHttp.use((http) => http.handle(request))), () =>
      Error(`not an API route: ${request.url}`),
    )
  return { fetch, calls, routines, runs, resident }
}

const send = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })

const decodeView = Schema.decodeUnknownSync(RoutineView)

/** A draft through the API: 201 and the routine as stored. */
const propose = async (fetch: (request: Request) => Promise<Response>, operationId = 'op-propose') => {
  const response = await fetch(send('POST', '/api/routines', { operationId, definition: DEFINITION }))
  expect(response.status).toBe(201)
  return decodeView(await response.json())
}

describe('the routines group served by the agent', () => {
  it('proposes a draft with 201, answers the same operation with the same draft, and lists it', async () => {
    const { fetch, resident } = fixture()
    const draft = await propose(fetch)
    expect(draft).toMatchObject({ state: 'proposed', revision: 1, definition: { title: 'Plants' } })
    expect(draft.id).toMatch(/^rt_\d+_\d+$/u)
    expect((await propose(fetch)).id).toBe(draft.id)
    const clash = await fetch(
      send('POST', '/api/routines', { operationId: 'op-propose', definition: { ...DEFINITION, title: 'Other' } }),
    )
    expect(clash.status).toBe(409)
    expect(await clash.json()).toMatchObject({
      error: { code: 'conflict', reason: 'operation id reused with different request' },
    })
    const list = await fetch(send('GET', '/api/routines'))
    expect(list.status).toBe(200)
    expect(Schema.decodeUnknownSync(RoutinePage)(await list.json()).routines.map((routine) => routine.id)).toEqual([
      draft.id,
    ])
    expect(resident.renewals).toHaveLength(4)
  })

  it('answers a definition the store refuses as 400 and a body that does not decode as 400', async () => {
    const { fetch } = fixture()
    const refused = await fetch(
      send('POST', '/api/routines', {
        operationId: 'op-1',
        definition: { ...DEFINITION, budget: { ...DEFINITION.budget, tokensPerDay: 10 } },
      }),
    )
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      error: { code: 'invalid_input', reason: 'daily budget below per-run budget' },
    })
    const shapeless = await fetch(send('POST', '/api/routines', { operationId: 'op-2' }))
    expect(shapeless.status).toBe(400)
    expect(await shapeless.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('reads and changes the settings, refusing caps out of range', async () => {
    const { fetch } = fixture()
    const settings = await fetch(send('GET', '/api/routines/settings'))
    expect(await settings.json()).toEqual({ timezone: 'UTC', maxActive: 20, maxRunning: 2 })
    const changed = await fetch(
      send('PUT', '/api/routines/settings', { timezone: 'Europe/Berlin', maxActive: 5, maxRunning: 1 }),
    )
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ timezone: 'Europe/Berlin', maxActive: 5, maxRunning: 1 })
    const refused = await fetch(
      send('PUT', '/api/routines/settings', { timezone: 'UTC', maxActive: 21, maxRunning: 1 }),
    )
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'routine caps' } })
  })

  it('edits, confirms, pauses and archives at the revision, reconciling after each, and refuses a stale one', async () => {
    const { fetch, calls } = fixture()
    const draft = await propose(fetch)
    const edited = await fetch(
      send('PATCH', `/api/routines/${draft.id}`, {
        revision: 1,
        operationId: 'op-edit',
        definition: { ...DEFINITION, title: 'Plants, daily' },
      }),
    )
    expect(decodeView(await edited.json())).toMatchObject({ revision: 2, definition: { title: 'Plants, daily' } })
    const stale = await fetch(send('POST', `/api/routines/${draft.id}/confirm`, { revision: 1, operationId: 'op-c1' }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'conflict', reason: 'stale routine revision' } })
    const confirmed = await fetch(
      send('POST', `/api/routines/${draft.id}/confirm`, { revision: 2, operationId: 'op-c2' }),
    )
    expect(decodeView(await confirmed.json())).toMatchObject({ state: 'activating', revision: 2 })
    const paused = await fetch(send('POST', `/api/routines/${draft.id}/pause`, { revision: 2, operationId: 'op-p' }))
    expect(decodeView(await paused.json())).toMatchObject({ state: 'paused' })
    const archived = await fetch(send('DELETE', `/api/routines/${draft.id}`, { revision: 2, operationId: 'op-a' }))
    expect(decodeView(await archived.json())).toMatchObject({ state: 'archived' })
    expect(calls).toEqual([
      'reconcile',
      `confirmEvents ${draft.id} 2`,
      'reconcile',
      'reconcile',
      `archive ${draft.id}`,
      'reconcile',
    ])
    const list = Schema.decodeUnknownSync(RoutinePage)(await (await fetch(send('GET', '/api/routines'))).json())
    expect(list.routines).toEqual([])
  })

  it('runs a routine now with 202 and lists its runs', async () => {
    const { fetch, routines } = fixture()
    const draft = await propose(fetch)
    await fetch(send('POST', `/api/routines/${draft.id}/confirm`, { revision: 1, operationId: 'op-c' }))
    routines.markActive(draft.id, 1, null, Date.now())
    const started = await fetch(
      send('POST', `/api/routines/${draft.id}/run`, { revision: 1, operationId: 'op-run', confirmRun: true }),
    )
    expect(started.status).toBe(202)
    const run = Schema.decodeUnknownSync(RoutineRunView)(await started.json())
    expect(run).toMatchObject({ id: 'rr_1', routineId: draft.id, state: 'admitted', source: 'manual' })
    expect(Object.keys(await (await fetch(send('GET', `/api/routines/${draft.id}/runs`))).json())).toEqual(['runs'])
    const page = await callOwner({ fetch }, (api) => api.routines.runs({ params: { id: draft.id } }))
    expect(page.runs.map((each) => each.id)).toEqual(['rr_1'])
  })

  it('answers an unknown routine as 404 not_found, and a path id that does not parse as 404 route', async () => {
    const { fetch } = fixture()
    const unknown = await fetch(send('GET', '/api/routines/rt_missing/runs'))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { code: 'not_found', what: 'routine' } })
    const typed = await callOwner({ fetch }, (api) =>
      Effect.flip(api.routines.pause({ params: { id: 'rt_missing' }, payload: { revision: 1, operationId: 'op' } })),
    )
    expect(typed).toMatchObject({ _tag: 'NotFound', what: 'routine' })
    const malformed = await fetch(send('PATCH', '/api/routines/settings', { revision: 1, operationId: 'op' }))
    expect(malformed.status).toBe(404)
    expect(await malformed.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
  })
})
