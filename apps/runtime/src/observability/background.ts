import * as Effect from 'effect/Effect'
import { reportFailure } from './report.ts'

/**
 * Runs `self` detached from the caller, which does not wait for it: finite work only, such as one reconcile or one
 * schedule call. Never a loop, a timer or anything meant to outlive the object; a Durable Object can be evicted at any
 * time. A failure is reported under `where`; an interruption is not a failure and is not reported.
 */
export const background =
  (where: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    self.pipe(
      reportFailure(where),
      // expected: reportFailure just reported it, and nothing waits for this fiber's result
      Effect.ignoreCause,
      Effect.forkDetach,
      Effect.asVoid,
    )
