import type { RoutineDefinition } from '@goblin/contracts'
import { RoutinePage, RoutineRunView, RoutineView } from '@goblin/contracts'
import { RoutinesGroup } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { Resident } from '../../../src/mcp/service.ts'
import { RoutinesHandlers } from '../../../src/routines/api.ts'
import { routineRunsOf, routinesOf } from '../../../src/layers/routines.ts'
import { RoutineRunStore } from '../../../src/routines/runs.ts'
import { RoutineControl, RoutineRuns, Routines } from '../../../src/routines/service.ts'
import { RoutineStore } from '../../../src/routines/store.ts'
import { callOwner } from '../../owner-client.ts'
import { currentResident, database, json, plans, post, serve, served, stub } from './fixture.ts'

const DEFINITION: RoutineDefinition = {
  title: 'Plants',
  prompt: 'Remind me to water the plants.',
  trigger: { kind: 'cron', expression: '0 9 * * *' },
  timezone: 'UTC',
  notifyTelegram: false,
  allowedTools: [],
  budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
}

/**
 * The routines group as the agent serves it, over the real routine stores on SQLite. The routines' runtime is the one
 * fake: it records what the handlers asked of it, and "run now" claims the run in the real store.
 */
const fixture = () => {
  const db = database()
  // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
  const sqlite = db as never
  const routines = new RoutineStore(sqlite, 'owner')
  const runs = new RoutineRunStore(sqlite, 'owner')
  const calls: string[] = []
  const record = (call: string) => Effect.sync(() => void calls.push(call))
  const control = stub(RoutineControl, {
    reconcile: record('reconcile'),
    confirmEvents: (id, revision) => record(`confirmEvents ${id} ${revision}`),
    archive: (id) => record(`archive ${id}`),
    manual: (id, input) =>
      Effect.sync(() => {
        calls.push(`manual ${id}`)
        const firing = {
          routineId: id,
          revision: input.revision,
          operationId: `routine-manual:${id}:${input.operationId}`,
          source: 'manual' as const,
          firedAt: 1,
        }
        return runs.claim(firing, 'rr_1', undefined, Date.now()).run
      }),
  })
  const resident = currentResident()
  const services = Layer.mergeAll(
    Layer.succeed(Routines, routinesOf(routines)),
    Layer.succeed(RoutineRuns, routineRunsOf(runs)),
    control,
    // The gate's resident authority and plan.
    Layer.succeed(Resident, resident.service),
    plans(),
  )
  const { fetch } = serve(served([RoutinesGroup], RoutinesHandlers).pipe(Layer.provide(services)))
  return { fetch, calls, routines, runs, resident }
}

const decodeView = Schema.decodeUnknownSync(RoutineView)

/** A draft through the API: 201 and the routine as stored. */
const propose = async (fetch: (request: Request) => Promise<Response>, operationId = 'op-propose') => {
  const response = await fetch(post('/api/routines', { operationId, definition: DEFINITION }))
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
      post('/api/routines', { operationId: 'op-propose', definition: { ...DEFINITION, title: 'Other' } }),
    )
    expect(clash.status).toBe(409)
    expect(await clash.json()).toMatchObject({
      error: { code: 'conflict', reason: 'operation id reused with different request' },
    })
    const list = await fetch(json('GET', '/api/routines'))
    expect(list.status).toBe(200)
    expect(Schema.decodeUnknownSync(RoutinePage)(await list.json()).routines.map((routine) => routine.id)).toEqual([
      draft.id,
    ])
    expect(resident.renewals).toHaveLength(4)
  })

  it('answers a definition the store refuses as 400 and a body that does not decode as 400', async () => {
    const { fetch } = fixture()
    const refused = await fetch(
      post('/api/routines', {
        operationId: 'op-1',
        definition: { ...DEFINITION, budget: { ...DEFINITION.budget, tokensPerDay: 10 } },
      }),
    )
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      error: { code: 'invalid_input', reason: 'daily budget below per-run budget' },
    })
    const shapeless = await fetch(post('/api/routines', { operationId: 'op-2' }))
    expect(shapeless.status).toBe(400)
    expect(await shapeless.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('reads and changes the settings, refusing caps out of range', async () => {
    const { fetch } = fixture()
    const settings = await fetch(json('GET', '/api/routines/settings'))
    expect(await settings.json()).toEqual({ timezone: 'UTC', maxActive: 20, maxRunning: 2 })
    const changed = await fetch(
      json('PUT', '/api/routines/settings', { timezone: 'Europe/Berlin', maxActive: 5, maxRunning: 1 }),
    )
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ timezone: 'Europe/Berlin', maxActive: 5, maxRunning: 1 })
    const refused = await fetch(
      json('PUT', '/api/routines/settings', { timezone: 'UTC', maxActive: 21, maxRunning: 1 }),
    )
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: 'invalid_input', reason: 'routine caps' } })
  })

  it('edits, confirms, pauses and archives at the revision, reconciling after each, and refuses a stale one', async () => {
    const { fetch, calls } = fixture()
    const draft = await propose(fetch)
    const edited = await fetch(
      json('PATCH', `/api/routines/${draft.id}`, {
        revision: 1,
        operationId: 'op-edit',
        definition: { ...DEFINITION, title: 'Plants, daily' },
      }),
    )
    expect(decodeView(await edited.json())).toMatchObject({ revision: 2, definition: { title: 'Plants, daily' } })
    const stale = await fetch(post(`/api/routines/${draft.id}/confirm`, { revision: 1, operationId: 'op-c1' }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'conflict', reason: 'stale routine revision' } })
    const confirmed = await fetch(post(`/api/routines/${draft.id}/confirm`, { revision: 2, operationId: 'op-c2' }))
    expect(decodeView(await confirmed.json())).toMatchObject({ state: 'activating', revision: 2 })
    const paused = await fetch(post(`/api/routines/${draft.id}/pause`, { revision: 2, operationId: 'op-p' }))
    expect(decodeView(await paused.json())).toMatchObject({ state: 'paused' })
    const archived = await fetch(json('DELETE', `/api/routines/${draft.id}`, { revision: 2, operationId: 'op-a' }))
    expect(decodeView(await archived.json())).toMatchObject({ state: 'archived' })
    expect(calls).toEqual([
      'reconcile',
      `confirmEvents ${draft.id} 2`,
      'reconcile',
      'reconcile',
      `archive ${draft.id}`,
      'reconcile',
    ])
    const list = Schema.decodeUnknownSync(RoutinePage)(await (await fetch(json('GET', '/api/routines'))).json())
    expect(list.routines).toEqual([])
  })

  it('runs a routine now with 202 and lists its runs', async () => {
    const { fetch, routines } = fixture()
    const draft = await propose(fetch)
    await fetch(post(`/api/routines/${draft.id}/confirm`, { revision: 1, operationId: 'op-c' }))
    routines.markActive(draft.id, 1, null, Date.now())
    const started = await fetch(
      post(`/api/routines/${draft.id}/run`, { revision: 1, operationId: 'op-run', confirmRun: true }),
    )
    expect(started.status).toBe(202)
    const run = Schema.decodeUnknownSync(RoutineRunView)(await started.json())
    expect(run).toMatchObject({ id: 'rr_1', routineId: draft.id, state: 'admitted', source: 'manual' })
    expect(Object.keys(await (await fetch(json('GET', `/api/routines/${draft.id}/runs`))).json())).toEqual(['runs'])
    const page = await callOwner({ fetch }, (api) => api.routines.runs({ params: { id: draft.id } }))
    expect(page.runs.map((each) => each.id)).toEqual(['rr_1'])
  })

  it('answers an unknown routine as 404 not_found, and a path id that does not parse as 404 route', async () => {
    const { fetch } = fixture()
    const unknown = await fetch(json('GET', '/api/routines/rt_missing/runs'))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { code: 'not_found', what: 'routine' } })
    const typed = await callOwner({ fetch }, (api) =>
      Effect.flip(api.routines.pause({ params: { id: 'rt_missing' }, payload: { revision: 1, operationId: 'op' } })),
    )
    expect(typed).toMatchObject({ _tag: 'NotFound', what: 'routine' })
    const malformed = await fetch(json('PATCH', '/api/routines/settings', { revision: 1, operationId: 'op' }))
    expect(malformed.status).toBe(404)
    expect(await malformed.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
  })
})
