import { ToolTask, defineExtension, hook } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { writeLine } from '../observability/logger.ts'
import { reportAndRecover, safeErrorType } from '../observability/report.ts'
import { requireRoutine } from '../routines/authority.ts'
import { RoutineRuns } from '../routines/service.ts'
import type { RunProgram } from '../runtime/bridge.ts'

/** Whether a routine's tool may run: `open`, refused by the routine's own limits or authority, or unchecked. */
export type RoutineToolVerdict = 'open' | 'refused' | 'failed'

/** What the model is told when a routine's tool is blocked. */
export const ROUTINE_BLOCKS: Readonly<Record<Exclude<RoutineToolVerdict, 'open'>, string>> = {
  refused: 'This routine has exhausted its budget, deadline or authority. No tool was run.',
  failed: 'This routine could not be checked, so no tool was run.',
}

const refused = () => Effect.succeed('refused' as const)

/**
 * A routine's tool call in Pi session `session`: refused when the session is no routine run, or when the routine's own
 * gate says no (no plan, resident authority off, the run not executing, its tokens or today's budget spent). Anything
 * else (storage, Pi or auth D1 failing) is reported and blocks the tool as a check that failed (ADR 0026).
 */
export const routineToolVerdict = (session: string) =>
  Effect.gen(function* () {
    const current = yield* (yield* RoutineRuns).session(session)
    if (current === undefined) return 'refused' as const
    yield* requireRoutine(current.id)
    return 'open' as const
  }).pipe(
    Effect.catchTags({
      SubscriptionRequired: refused,
      ResidentInactive: refused,
      Forbidden: refused,
      BudgetExhausted: refused,
    }),
    reportAndRecover('routines.beforeTool', 'failed' as const),
  )

/** The check could not run at all (the agent's runtime did not start): the tool is blocked as a failed check. */
const reportUnchecked = (error: unknown): RoutineToolVerdict => {
  writeLine('error', { event: 'failure', where: 'routines.beforeTool', 'error.type': safeErrorType(error) })
  return 'failed'
}

/** Routine calls use the same model and tool authority gate, with deduplicated response usage receipts. */
export function routineBudgetExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.routine-budget',
    hooks: [
      hook(ToolTask, {
        beforeTool: async (_call, api) => {
          const verdict = await run(routineToolVerdict(String(api.conversationId))).catch(reportUnchecked)
          return verdict === 'open' ? undefined : { block: ROUTINE_BLOCKS[verdict] }
        },
      }),
    ],
  })
}
