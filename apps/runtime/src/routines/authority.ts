import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { Entitlements } from '../billing/gates.ts'
import { BudgetExhausted, Forbidden } from '../http/errors.ts'
import {
  RoutineRuns,
  RoutineUsageProjection,
  attempt,
  attemptSync,
  requireBudget,
  requireResident,
} from '../services.ts'
import { definitionOf } from './runs.ts'

/** The dedicated routine provider resolves this before every model dispatch, including recovery and compaction. */
export const requireRoutine = (runId: string) =>
  Effect.gen(function* () {
    yield* Entitlements.use((plans) => plans.require('routines'))
    yield* requireResident
    const store = yield* RoutineRuns
    const at = yield* Clock.currentTimeMillis
    const run = yield* attemptSync(() => store.get(runId))
    if (run.state !== 'running' || run.deadlineAt <= at)
      return yield* new Forbidden({ reason: 'routine run is not executing' })
    const session = run.sessionId
    if (session !== null) {
      const projection = yield* RoutineUsageProjection
      yield* attempt(() => projection.snapshot(session))
    }
    yield* requireBudget
    const definition = definitionOf(run)
    const used = store.used(runId, at)
    if (used.run >= definition.budget.tokensPerRun || used.day >= definition.budget.tokensPerDay)
      return yield* new BudgetExhausted({
        limit: definition.budget.tokensPerRun,
        resetsAt: (Math.floor(at / 86_400_000) + 1) * 86_400,
      })
  })

export const requireRoutineSession = (session: string) =>
  Effect.gen(function* () {
    const run = (yield* RoutineRuns).session(session)
    if (run !== undefined) yield* requireRoutine(run.id)
  })
