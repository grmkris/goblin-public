import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { requirePlan } from '../billing/gates.ts'
import { attempt } from '../http/errors.ts'
import { reportFailure } from '../observability/report.ts'
import { AgentInput } from '../runtime/input.ts'
import { Events } from './service.ts'

/** How long until a sweep that failed is tried again. */
const RETRY_MS = 60_000

/**
 * The Events alarm (`mcpEventsWake`): the plan, then one maintenance sweep, which keeps the next alarm itself. A sweep
 * that fails is reported (an owner's refusal, such as revoked authority, is expected and is not); either failure tries
 * again in a minute, but only while something waits: with no subscription or delivery left, no alarm is kept.
 */
export const mcpEventsWake = Effect.andThen(
  requirePlan(),
  Events.use((events) => events.maintain()).pipe(reportFailure('mcp.events.wake')),
).pipe(
  // expected: the sweep's failure was reported above, and a refused plan is the owner's; either way, a minute on.
  Effect.catch(() =>
    Effect.gen(function* () {
      const due = yield* Events.use((events) => events.nextDue())
      if (due === undefined) return
      const now = yield* Clock.currentTimeMillis
      yield* AgentInput.use((input) => attempt(() => input.scheduleEvents(Math.max(due, now + RETRY_MS))))
    }),
  ),
)
