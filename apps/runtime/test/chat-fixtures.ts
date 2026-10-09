import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Budget, type ModelBudget } from '../src/budget.ts'
import type { ChatDirectory } from '../src/chats/directory.ts'
import { toAppError } from '../src/http/errors.ts'
import { ChatOperationsAdapter, ChatsAdapter } from '../src/layers/conversation.ts'
import { Models, type ModelPicker } from '../src/models.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { Chats as LegacyChats } from '../src/services.ts'

/** A probe's own instances, which the Telegram ports' programs read (channel/turns.ts). */
type PortInstances = {
  readonly chats: ChatDirectory
  readonly harness: PiHarness
  readonly budget: ModelBudget
  readonly models: ModelPicker
}

/**
 * The services the Telegram ports' programs read, over a probe's own instances: lane C's directory and admission
 * adapters over its chat directory, and its budget and model picker as the routines lane's services wrap them.
 */
export const portServices = ({ chats, harness, budget, models }: PortInstances) =>
  Layer.mergeAll(
    Layer.mergeAll(ChatsAdapter, ChatOperationsAdapter).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(LegacyChats, chats),
          // SAFETY: the admission adapters read only Pi's harness from the instance input.
          Layer.succeed(AgentInput, { harness } as AgentInputs),
        ),
      ),
    ),
    Layer.succeed(
      Budget,
      Budget.of({
        today: (now) => Effect.tryPromise({ try: () => budget.today(now), catch: toAppError }),
        record: (use, now, model) => Effect.sync(() => budget.record(use, now, model)),
        require: (now) => Effect.tryPromise({ try: () => budget.require(now), catch: toAppError }),
      }),
    ),
    Layer.succeed(
      Models,
      Models.of({
        current: Effect.sync(() => models.current()),
        choice: Effect.sync(() => models.choice()),
        choose: (modelId, now) => Effect.try({ try: () => models.choose(modelId, now), catch: toAppError }),
      }),
    ),
  )
