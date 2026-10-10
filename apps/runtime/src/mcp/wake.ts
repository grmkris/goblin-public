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
 * The Events alarm (`mcpEventsWake`): the plan, then one maintenance sweep. A sweep that fails is reported (an owner's
 * refusal, such as revoked authority, is expected and is not); either failure tries again in a minute.
 */
export const mcpEventsWake = Effect.andThen(
  requirePlan(),
  Events.use((events) => events.maintain()).pipe(reportFailure('mcp.events.wake')),
).pipe(
  // expected: the sweep's failure was reported above, and a refused plan is the owner's; either way, a minute on.
  Effect.catch(() =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      AgentInput.use((input) => attempt(() => input.scheduleEvents(now + RETRY_MS))),
    ),
  ),
)
