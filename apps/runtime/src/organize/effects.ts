import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { type AppError, toAppError } from '../http/errors.ts'

/** The instance clock in epoch seconds, as Topics, Personas, receipts and invocations keep time. */
export const nowSeconds: Effect.Effect<number> = Effect.map(Clock.currentTimeMillis, (millis) =>
  Math.floor(millis / 1000),
)

/**
 * A synchronous store call that throws its typed failures (a missing row, a taken name, a stale revision): its
 * `AppError`, or `Internal` for anything else (`toAppError`), as the programs have always taken a store's refusals.
 */
export const fromStore = <A>(call: () => A): Effect.Effect<A, AppError> => Effect.try({ try: call, catch: toAppError })

/** An async store call, taken the same way. */
export const fromStoreAsync = <A>(call: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({ try: call, catch: toAppError })
