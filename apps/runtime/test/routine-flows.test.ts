import type { Harness } from '@earendil-works/pi-durable'
import type { RoutineDefinition } from '@goblin/contracts'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import { Entitlements } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Budget } from '../src/budget.ts'
import { ChatId, SessionId } from '../src/chats/directory.ts'
import { Chats, Conversations, type RoutineReport } from '../src/chats/service.ts'
import { type AppError, BudgetExhausted, Internal } from '../src/http/errors.ts'
import { noticesOf, routineRunsOf, routinesOf } from '../src/layers/routines.ts'
import { Notices } from '../src/notices/service.ts'
import { Changes, makeChanges } from '../src/runtime/changes.ts'
import { NoticeStore } from '../src/notices/store.ts'
import { Cipher } from '../src/mcp/cipher.ts'
import { Resident } from '../src/mcp/service.ts'
import { Models } from '../src/models.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { PersonaRegistry } from '../src/personas/registry.ts'
import { Personas } from '../src/personas/service.ts'
import type { RoutineStart } from '../src/pi/routine-run.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { admit, reportRun } from '../src/routines/runner.ts'
import { RoutineRunStore } from '../src/routines/runs.ts'
import type { RoutineSchedules } from '../src/routines/scheduler.ts'
import { RoutineRuns, RoutineUsage, Routines } from '../src/routines/service.ts'
import { RoutineStore } from '../src/routines/store.ts'
import { AgentInput } from '../src/runtime/input.ts'
import { chatDatabase, durable } from './chats-sqlite.ts'
import { stub } from './http/api/fixture.ts'
import { PERSONAL_TOPIC } from '@goblin/contracts'

const PLAN: AccountPlan = {
  active: true,
  source: 'override',
  until: null,
  dailyCredits: 800,
  status: 'active',
  hasCustomer: false,
  cancelAtPeriodEnd: false,
}
const DEFINITION: RoutineDefinition = {
  title: 'Daily',
  trigger: { kind: 'cron', expression: '0 9 * * *' },
  timezone: 'UTC',
  tellMe: { on: false, telegram: false },
  handTo: {
    kind: 'goblin',
    instruction: 'Report.',
    allowedTools: [],
    budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
  },
}

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/** The agent's native schedules, which these runs never need: every alarm is accepted and nothing is listed. */
const schedules: RoutineSchedules = {
  list: async () => [],
  arm: async () => 'schedule-1',
  cancel: async () => undefined,
  wake: async () => undefined,
  deadline: async () => undefined,
}

/** The routine handed to Persona `persona` at `revision` instead of Goblin, with the same instruction and limits. */
const toPersona = (persona: number, revision: number): RoutineDefinition['handTo'] => {
  if (DEFINITION.handTo.kind === 'none') throw new Error('the fixture hands its work over')
  const { instruction, allowedTools, budget } = DEFINITION.handTo
  return { kind: 'persona', persona, revision, instruction, allowedTools, budget }
}

/**
 * The routines' programs over the real routine and Persona stores on SQLite, one confirmed active routine (handed to
 * Goblin, or to the Persona Worker with `persona`), and flow events captured. The plan and the budget answer as `gate`
 * says; Pi's start only names the session, and the starts and reports are kept.
 */
const fixture = (
  gate: { plan?: Effect.Effect<AccountPlan, Internal>; budget?: Effect.Effect<void, AppError> } = {},
  persona = false,
) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  const sqlite = durable(db)
  const registry = new PersonaRegistry(sqlite, ['model-a', 'model-p'])
  const worker = registry.create(
    {
      name: 'Worker',
      avatar: { glyph: 'W', hue: 120 },
      role: 'Quotes jobs',
      instructions: 'Quote fairly.',
      model: 'model-p',
      setup: { mcpServers: [], skills: [], apps: [] },
      operationId: 'op-worker',
    },
    'owner',
    1,
  ).persona
  const routines = new RoutineStore(sqlite, 'owner')
  const runs = new RoutineRunStore(sqlite, 'owner')
  const definition = persona ? { ...DEFINITION, handTo: toPersona(worker.id, worker.revision) } : DEFINITION
  const routine = routines.propose(definition, 'op-propose', 'rt_1', Date.now(), PERSONAL_TOPIC).routine
  routines.confirm(routine.id, 1, 'op-confirm', Date.now())
  routines.markActive(routine.id, 1, null, Date.now())
  const flows: FlowEvent[] = []
  const starts: RoutineStart[] = []
  const reports: RoutineReport[] = []
  const changes = makeChanges()
  const personas = Effect.runSync(Personas.make(registry).pipe(Effect.provideService(Changes, changes)))
  const layer = Layer.mergeAll(
    Layer.succeed(Routines, routinesOf(routines)),
    Layer.succeed(RoutineRuns, routineRunsOf(runs)),
    FlowEvents.layerWith((event) => Effect.sync(() => void flows.push(event))),
    Layer.succeed(Entitlements, {
      state: () => Effect.succeed(PLAN),
      require: () => gate.plan ?? Effect.succeed(PLAN),
    }),
    stub(Resident, { require: () => Effect.void }),
    stub(Budget, { require: () => gate.budget ?? Effect.void }),
    stub(Models, { current: Effect.succeed('model-a') }),
    stub(Chats, { primary: ChatId('1'), session: () => Effect.succeed(SessionId('1')) }),
    // SAFETY: the start below never touches the opened Pi it is handed.
    stub(PiSessions, { pi: Effect.succeed({} as Harness) }),
    stub(Cipher),
    stub(Conversations, { reportRoutine: (report) => Effect.sync(() => void reports.push(report)) }),
    stub(RoutineUsage, { snapshot: () => Effect.void }),
    Layer.succeed(Notices, noticesOf(new NoticeStore(sqlite))),
    Layer.succeed(Changes, changes),
    Layer.succeed(Personas, personas),
    stub(AgentInput, {
      routineSchedules: schedules,
      startRoutine: async (_pi, start) => {
        starts.push(start)
        return 'session-1'
      },
    }),
  )
  const run = <A>(program: Effect.Effect<A, AppError, Layer.Success<typeof layer>>) =>
    Effect.runPromise(program.pipe(Effect.provide(layer)))
  const firing = (operationId: string) => ({
    routineId: routine.id,
    revision: 1,
    operationId,
    source: 'cron' as const,
    firedAt: Date.now(),
  })
  return { run, runs, routines, registry, worker, flows, firing, starts, reports }
}

describe('routine flows', () => {
  it('records a firing once admitted, and the same operation again as replayed', async () => {
    const { run, flows, firing } = fixture()
    await run(admit(firing('routine:rt_1:1')))
    await run(admit(firing('routine:rt_1:1')))
    expect(flows).toEqual([
      { flow: 'routine_fire', via: 'schedule', actor: 'routine', operationId: 'routine:rt_1:1', status: 'ok' },
      { flow: 'routine_fire', via: 'schedule', actor: 'routine', operationId: 'routine:rt_1:1', status: 'replayed' },
    ])
  })

  it('records a firing the budget turned away as refused, and a failed admission as an error', async () => {
    const spent = fixture({ budget: Effect.fail(new BudgetExhausted({ limit: 800, resetsAt: 86_400 })) })
    const skipped = await spent.run(admit(spent.firing('routine:rt_1:2')))
    expect(skipped.state).toBe('skipped')
    expect(spent.flows).toMatchObject([{ flow: 'routine_fire', status: 'refused' }])
    const down = fixture({ plan: Effect.fail(new Internal({ reason: 'billing storage unavailable' })) })
    await expect(down.run(admit(down.firing('routine:rt_1:3')))).rejects.toMatchObject({ _tag: 'Internal' })
    expect(down.flows).toMatchObject([{ flow: 'routine_fire', status: 'error', errorType: 'Internal' }])
  })

  it("records a run's report under the run's operation, in its Topic", async () => {
    const { run, runs, flows, firing } = fixture()
    const admitted = await run(admit(firing('routine:rt_1:4')))
    runs.settle(admitted.id, 'completed', 'Done.', Date.now())
    await run(reportRun(runs.get(admitted.id)))
    expect(flows.at(-1)).toEqual({
      flow: 'routine_report',
      via: 'system',
      actor: 'routine',
      operationId: `routine-report:${admitted.id}`,
      parentOperation: 'routine:rt_1:4',
      topic: 1,
      status: 'ok',
    })
  })

  it('runs a routine handed to a Persona as that Persona at the pinned revision, and writes its answer as its own', async () => {
    const { run, runs, flows, firing, starts, reports } = fixture({}, true)
    const admitted = await run(admit(firing('routine:rt_1:5')))
    expect(admitted.state).toBe('admitted')
    expect(starts.at(-1)?.persona).toMatchObject({ name: 'Worker', revision: 1, model: 'model-p', role: 'Quotes jobs' })
    runs.settle(admitted.id, 'completed', 'Quoted 40 USDC.', Date.now())
    await run(reportRun(runs.get(admitted.id)))
    expect(reports.at(-1)).toMatchObject({
      text: 'Quoted 40 USDC.',
      persona: { name: 'Worker', revision: 1, avatar: { glyph: 'W', hue: 120 } },
    })
    expect(flows.at(-1)).toMatchObject({ flow: 'routine_report', status: 'ok' })
  })

  it('skips a firing and pauses the routine once its Persona changed since the pin, or was archived', async () => {
    const { run, routines, registry, worker, firing, starts } = fixture({}, true)
    registry.update(worker.id, { role: 'Quotes and delivers', expectedRevision: 1 }, 'owner', 2)
    const skipped = await run(admit(firing('routine:rt_1:6')))
    expect(skipped).toMatchObject({ state: 'skipped', outcome: 'persona_changed' })
    expect(starts).toEqual([])
    expect(routines.get('rt_1')).toMatchObject({ state: 'paused', health: 'persona_changed' })
    const archived = fixture({}, true)
    archived.registry.update(archived.worker.id, { archived: true, expectedRevision: 1 }, 'owner', 2)
    expect(await archived.run(admit(archived.firing('routine:rt_1:7')))).toMatchObject({ outcome: 'persona_archived' })
  })

  it('refuses to confirm a routine whose Persona changed since it was proposed', async () => {
    const { routines, registry, worker } = fixture({}, true)
    const stale = { ...DEFINITION, handTo: toPersona(worker.id, worker.revision) }
    const draft = routines.propose(stale, 'op-stale', 'rt_2', Date.now(), PERSONAL_TOPIC).routine
    registry.update(worker.id, { instructions: 'Quote high.', expectedRevision: 1 }, 'owner', 2)
    expect(() => routines.confirm(draft.id, 1, 'op-stale-confirm', Date.now())).toThrow(
      expect.objectContaining({ _tag: 'Conflict', reason: 'persona_changed' }),
    )
    const next = { ...DEFINITION, handTo: toPersona(worker.id, 1) }
    expect(() => routines.propose(next, 'op-old-pin', 'rt_3', Date.now(), PERSONAL_TOPIC)).toThrow(
      expect.objectContaining({ reason: 'persona_changed' }),
    )
  })
})
