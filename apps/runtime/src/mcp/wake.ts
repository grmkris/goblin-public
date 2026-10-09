import type { RunProgram } from '../runtime/bridge.ts'
import { Events } from './service.ts'

/** The Events alarm (`mcpEventsWake`): one maintenance sweep; a failed one is tried again in a minute. */
export async function mcpEventsWake(run: RunProgram, wake: (at: number) => Promise<void>): Promise<void> {
  await run(Events.use((events) => events.maintain())).catch(() => wake(Date.now() + 60_000))
}
