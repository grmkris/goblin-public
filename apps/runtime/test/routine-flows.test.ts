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
import { Chats, Conversations } from '../src/chats/service.ts'
import { type AppError, BudgetExhausted, Internal } from '../src/http/errors.ts'
import { routineRunsOf, routinesOf } from '../src/layers/routines.ts'
import { Cipher } from '../src/mcp/cipher.ts'
import { Resident } from '../src/mcp/service.ts'
import { Models } from '../src/models.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { admit, reportRun } from '../src/routines/runner.ts'
import { RoutineRunStore } from '../src/routines/runs.ts'
import type { RoutineSchedules } from '../src/routines/scheduler.ts'
import { RoutineRuns, RoutineUsage, Routines } from '../src/routines/service.ts'
import { RoutineStore } from '../src/routines/store.ts'
import { AgentInput } from '../src/runtime/input.ts'
import { chatDatabase } from './chats-sqlite.ts'
import { stub } from './http/api/fixture.ts'

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
  prompt: 'Report.',
  trigger: { kind: 'cron', expression: '0 9 * * *' },
  timezone: 'UTC',
  notifyTelegram: false,
  allowedTools: [],
  budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
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

/**
 * The routines' programs over the real routine stores on SQLite, one confirmed active routine, and flow events
 * captured. The plan and the budget answer as `gate` says; Pi's start only names the session.
 */
const fixture = (
  gate: { plan?: Effect.Effect<AccountPlan, Internal>; budget?: Effect.Effect<void, AppError> } = {},
) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  // SAFETY: node:sqlite's Drizzle driver runs the same synchronous query builder as the Durable Object's.
  const sqlite = db as never
  const routines = new RoutineStore(sqlite, 'owner')
  const runs = new RoutineRunStore(sqlite, 'owner')
  const routine = routines.propose(DEFINITION, 'op-propose', 'rt_1', Date.now()).routine
  routines.confirm(routine.id, 1, 'op-confirm', Date.now())
  routines.markActive(routine.id, 1, null, Date.now())
  const flows: FlowEvent[] = []
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
    stub(Conversations, { reportRoutine: () => Effect.void }),
    stub(RoutineUsage, { snapshot: () => Effect.void }),
    stub(AgentInput, { routineSchedules: schedules, startRoutine: async () => 'session-1' }),
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
  return { run, runs, flows, firing }
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
})
