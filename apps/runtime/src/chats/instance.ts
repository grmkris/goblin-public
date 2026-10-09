import type { PiOperationResult } from 'agents/harness/pi'
import * as Clock from 'effect/Clock'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import { Budget } from '../budget.ts'
import { type AppError, toAppError } from '../http/errors.ts'
import { PiSessions } from '../pi/sessions.ts'

/** The Clock's time in epoch seconds, which the conversation programs stamp rows and check the budget with. */
export const epochSeconds: Effect.Effect<number> = Effect.map(Clock.currentTimeMillis, (millis) =>
  Math.floor(millis / 1000),
)

/** Fails with `BudgetExhausted` once today's model budget is spent (ADR 0026). */
export const withinBudget: Effect.Effect<void, AppError, Budget> = Effect.gen(function* () {
  const budget = yield* Budget
  yield* budget.require(yield* epochSeconds)
})

/**
 * How `operationId` ended in `session` if Pi settles it within `ms`; none while it still runs. A wait that fails for
 * any other reason is that failure, never "still running" (C2, C3).
 */
export const settledWithin = (
  session: string,
  operationId: string,
  ms: number,
): Effect.Effect<Option.Option<PiOperationResult>, AppError, PiSessions> =>
  PiSessions.use((pi) => pi.wait(session, operationId)).pipe(
    Effect.timeoutOption(Duration.millis(ms)),
    Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
  )

/**
 * One call into a Promise API of the agent's instance (Pi's harness, the Persona and subagent kits, the routine
 * controller it made), failing with the `AppError` the call threw, else `Internal`. Wave 3 puts these behind Effect
 * services (`PiSessions` and lane D's).
 */
export const instanceCall = <A>(call: () => PromiseLike<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({ try: call, catch: toAppError })
