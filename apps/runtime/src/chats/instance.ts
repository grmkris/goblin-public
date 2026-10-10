import type { PiOperationResult } from 'agents/harness/pi'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import { type AppError, toAppError } from '../http/errors.ts'
import { PiSessions } from '../pi/sessions.ts'

/**
 * How `operationId` ended in `session` if Pi settles it within `ms`; none while it still runs. A wait that fails for
 * any other reason is that failure, never "still running".
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
