import { ToolTask, defineExtension, hook } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { RoutineRuns } from '../services.ts'
import { requireRoutine } from '../routines/authority.ts'
import type { RunProgram } from './resident-mcp.ts'

/** Routine calls use the same model and tool authority gate, with deduplicated response usage receipts. */
export function routineBudgetExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.routine-budget',
    hooks: [
      hook(ToolTask, {
        beforeTool: async (_call, api) => {
          const blocked = await run(
            Effect.gen(function* () {
              const current = (yield* RoutineRuns).session(String(api.conversationId))
              if (current === undefined) return true
              return yield* requireRoutine(current.id).pipe(
                Effect.as(false),
                Effect.catch(() => Effect.succeed(true)),
              )
            }),
          ).catch(() => true)
          return blocked
            ? { block: 'This routine has exhausted its budget, deadline or authority. No tool was run.' }
            : undefined
        },
      }),
    ],
  })
}
