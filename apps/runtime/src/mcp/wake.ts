import { reportFailure } from '../observability/report.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { Events } from './service.ts'

/** How long until a sweep that failed is tried again. */
const RETRY_MS = 60_000

/**
 * The Events alarm (`mcpEventsWake`): one maintenance sweep. A sweep that fails is reported (an owner's refusal, such as
 * revoked authority, is expected and is not) and tried again in a minute.
 */
export async function mcpEventsWake(run: RunProgram, wake: (at: number) => Promise<void>): Promise<void> {
  await run(Events.use((events) => events.maintain()).pipe(reportFailure('mcp.events.wake'))).catch(() =>
    // expected: the failure was reported inside the program; the alarm only reschedules the sweep.
    wake(Date.now() + RETRY_MS),
  )
}
