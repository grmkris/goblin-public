import type { RoutineDefinition } from '@goblin/contracts'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it } from 'vitest'
import { Entitlements } from '../src/billing/gates.ts'
import type { AccountPlan } from '../src/billing/reconcile.ts'
import { Budget } from '../src/budget.ts'
import { Conversations } from '../src/chats/service.ts'
import { type AppError, BudgetExhausted, Internal } from '../src/http/errors.ts'
import { routineRunsOf, routinesOf } from '../src/layers/routines.ts'
import { Resident } from '../src/mcp/service.ts'
import { Models } from '../src/models.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { RoutineRunner } from '../src/routines/runner.ts'
import { RoutineRunStore } from '../src/routines/runs.ts'
import { RoutineRuns, RoutineUsage, Routines } from '../src/routines/service.ts'
import { RoutineStore } from '../src/routines/store.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { chatDatabase } from './chats-sqlite.ts'

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

/** A stand-in implementing only the members the runner reaches. */
const fake = <T>(members: Partial<T>): T =>
  // SAFETY: each fake below is given every member admission, start and report call on it.
  members as T

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/**
 * The runner over the real routine stores on SQLite, one confirmed active routine, and flow events captured. The plan
 * and the budget answer as `gate` says; Pi's start only names the session.
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
    Layer.succeed(Resident, fake<typeof Resident.Service>({ require: () => Effect.void })),
    Layer.succeed(Budget, fake<typeof Budget.Service>({ require: () => gate.budget ?? Effect.void })),
    Layer.succeed(Models, fake<typeof Models.Service>({ current: Effect.succeed('model-a') })),
    Layer.succeed(Conversations, fake<typeof Conversations.Service>({ reportRoutine: () => Effect.void })),
    Layer.succeed(RoutineUsage, fake<typeof RoutineUsage.Service>({ snapshot: () => Effect.void })),
  )
  // SAFETY: every program the runner hands its bridge reads only the services in `layer`.
  const run = ((program: Effect.Effect<unknown, AppError>) =>
    Effect.runPromise(program.pipe(Effect.provide(layer)))) as RunProgram
  const harness = fake<PiHarness>({})
  const runner = new RoutineRunner(
    run,
    harness,
    async () => 'session-1',
    async () => undefined,
  )
  const firing = (operationId: string) => ({
    routineId: routine.id,
    revision: 1,
    operationId,
    source: 'cron' as const,
    firedAt: Date.now(),
  })
  return { runner, runs, flows, firing }
}

describe('routine flows', () => {
  it('records a firing once admitted, and the same operation again as replayed', async () => {
    const { runner, flows, firing } = fixture()
    await runner.admit(firing('routine:rt_1:1'))
    await runner.admit(firing('routine:rt_1:1'))
    expect(flows).toEqual([
      { flow: 'routine_fire', via: 'schedule', actor: 'routine', operationId: 'routine:rt_1:1', status: 'ok' },
      { flow: 'routine_fire', via: 'schedule', actor: 'routine', operationId: 'routine:rt_1:1', status: 'replayed' },
    ])
  })

  it('records a firing the budget turned away as refused, and a failed admission as an error', async () => {
    const spent = fixture({ budget: Effect.fail(new BudgetExhausted({ limit: 800, resetsAt: 86_400 })) })
    const skipped = await spent.runner.admit(spent.firing('routine:rt_1:2'))
    expect(skipped.state).toBe('skipped')
    expect(spent.flows).toMatchObject([{ flow: 'routine_fire', status: 'refused' }])
    const down = fixture({ plan: Effect.fail(new Internal({ reason: 'billing storage unavailable' })) })
    await expect(down.runner.admit(down.firing('routine:rt_1:3'))).rejects.toMatchObject({ _tag: 'Internal' })
    expect(down.flows).toMatchObject([{ flow: 'routine_fire', status: 'error', errorType: 'Internal' }])
  })

  it("records a run's report under the run's operation, in its Topic", async () => {
    const { runner, runs, flows, firing } = fixture()
    const run = await runner.admit(firing('routine:rt_1:4'))
    runs.settle(run.id, 'completed', 'Done.', Date.now())
    await runner.report(runs.get(run.id))
    expect(flows.at(-1)).toEqual({
      flow: 'routine_report',
      via: 'system',
      actor: 'routine',
      operationId: `routine-report:${run.id}`,
      parentOperation: 'routine:rt_1:4',
      topic: 1,
      status: 'ok',
    })
  })
})
