import { GenerationTask, ToolTask, defineExtension, hook } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { Budget } from '../budget.ts'
import { writeLine } from '../observability/logger.ts'
import { reportAndRecover, safeErrorType } from '../observability/report.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { epochSeconds } from '../clock.ts'
import { PAID_PROVIDER_PREFIX } from './model.ts'

/** Why a tool may not run against today's budget, or `open` when it may. */
export type BudgetVerdict = 'open' | 'exhausted' | 'unsubscribed' | 'failed'

/** What the model is told when a tool is blocked: only a spent budget reads as spent. */
export const BUDGET_BLOCKS: Readonly<Record<Exclude<BudgetVerdict, 'open'>, string>> = {
  exhausted:
    "Today's model budget is used up, so this tool was not run. Tell the user, and that the budget resets at 00:00 UTC.",
  unsubscribed:
    'The account has no plan, so this tool was not run. Tell the user to pick goblin Pro (a day pass or monthly).',
  failed: "Today's model budget could not be checked, so this tool was not run. Tell the user, then try again later.",
}

/**
 * Today's budget as a tool sees it: spent (`BudgetExhausted` or used up), not subscribed (`SubscriptionRequired`), or
 * open. Anything else (auth D1 or the ledger failing) is reported and fails closed as a check that failed, never as a
 * spent budget.
 */
export const budgetVerdict: Effect.Effect<BudgetVerdict, never, Budget> = Effect.gen(function* () {
  const budget = yield* Budget
  // `open` refuses a spent day unless the owner's pay mode lets their wallet pay the calls (ADR 0047). It never pays a
  // day pass's day: a routine's tool call is not the owner using goblin (ADR 0054).
  yield* budget.open(yield* epochSeconds)
  return 'open' as const
}).pipe(
  Effect.catchTags({
    BudgetExhausted: () => Effect.succeed('exhausted' as const),
    SubscriptionRequired: () => Effect.succeed('unsubscribed' as const),
  }),
  reportAndRecover('budget.beforeTool', 'failed' as const),
)

/** The check could not run at all (the agent's runtime did not start): the tool is blocked as a failed check. */
const reportUnchecked = (error: unknown): BudgetVerdict => {
  writeLine('error', { event: 'failure', where: 'budget.beforeTool', 'error.type': safeErrorType(error) })
  return 'failed'
}

/**
 * The user's daily model budget inside a turn. Every response's tokens are recorded and priced in Credits at its
 * model's rate (ADR 0026); once the budget is spent, tool calls are blocked, so a turn looping through tools ends after
 * one more reply. New turns are refused at submission (agent.ts). Pi reports and swallows hook exceptions, so blocking
 * a tool is the lever, not throwing. Both hooks run through `local`: the budget reads the plan itself.
 */
export function budgetExtension(local: RunProgram) {
  return defineExtension({
    name: 'goblin.budget',
    hooks: [
      hook(GenerationTask, {
        afterResponse: async (message) => {
          // A call paid from the owner's wallet (ADR 0047) costs no Credits.
          if (message.provider.startsWith(PAID_PROVIDER_PREFIX)) return
          await local(
            Effect.gen(function* () {
              const budget = yield* Budget
              yield* budget.record(message.usage, yield* epochSeconds, message.model)
            }),
          )
        },
      }),
      hook(ToolTask, {
        beforeTool: async () => {
          const verdict = await local(budgetVerdict).catch(reportUnchecked)
          return verdict === 'open' ? undefined : { block: BUDGET_BLOCKS[verdict] }
        },
      }),
    ],
  })
}
