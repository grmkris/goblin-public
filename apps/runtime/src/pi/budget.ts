import { GenerationTask, ToolTask, defineExtension, hook } from '@earendil-works/pi-durable'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { Budget } from '../budget.ts'
import type { RunProgram } from '../runtime/bridge.ts'

const EXHAUSTED =
  "Today's model budget is used up, so this tool was not run. Tell the user, and that the budget resets at 00:00 UTC."

const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

const spent = Effect.gen(function* () {
  const budget = yield* Budget
  const today = yield* budget.today(yield* nowSeconds)
  return today.used >= today.limit
})

/**
 * The user's daily model budget inside a turn. Every response's tokens are recorded and priced in Credits at its
 * model's rate (ADR 0026); once the budget is spent, tool calls are blocked, so a turn looping through tools ends after
 * one more reply. New turns are refused at submission (agent.ts). Pi reports and swallows hook exceptions, so blocking
 * a tool is the lever, not throwing.
 */
export function budgetExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.budget',
    hooks: [
      hook(GenerationTask, {
        afterResponse: async (message) => {
          await run(
            Effect.gen(function* () {
              const budget = yield* Budget
              yield* budget.record(message.usage, yield* nowSeconds, message.model)
            }),
          )
        },
      }),
      hook(ToolTask, {
        beforeTool: async () => ((await run(spent).catch(() => true)) ? { block: EXHAUSTED } : undefined),
      }),
    ],
  })
}
