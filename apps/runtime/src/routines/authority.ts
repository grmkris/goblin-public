import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { requirePlan } from '../billing/gates.ts'
import { requireBudget } from '../budget.ts'
import { BudgetExhausted, Forbidden } from '../http/errors.ts'
import { requireResident } from '../mcp/service.ts'
import { definitionOf } from './store.ts'
import { RoutineRuns, RoutineUsage } from './service.ts'

/** The dedicated routine provider resolves this before every model dispatch, including recovery and compaction. */
export const requireRoutine = Effect.fn('routines.requireRoutine')(function* (runId: string) {
  yield* requirePlan('routines')
  yield* requireResident
  const store = yield* RoutineRuns
  const at = yield* Clock.currentTimeMillis
  const run = yield* store.get(runId)
  if (run.state !== 'running' || run.deadlineAt <= at)
    return yield* new Forbidden({ reason: 'routine run is not executing' })
  const session = run.sessionId
  if (session !== null) yield* RoutineUsage.use((projection) => projection.snapshot(session))
  yield* requireBudget
  const definition = definitionOf(run)
  const used = yield* store.used(runId, at)
  if (used.run >= definition.budget.tokensPerRun || used.day >= definition.budget.tokensPerDay)
    return yield* new BudgetExhausted({
      limit: definition.budget.tokensPerRun,
      resetsAt: (Math.floor(at / 86_400_000) + 1) * 86_400,
    })
})

export const requireRoutineSession = Effect.fn('routines.requireRoutineSession')(function* (session: string) {
  const run = yield* RoutineRuns.use((store) => store.session(session))
  if (run !== undefined) yield* requireRoutine(run.id)
})
