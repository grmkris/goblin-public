import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Budget, type ModelBudget } from '../src/budget.ts'
import type { ChatDirectory } from '../src/chats/directory.ts'
import { toAppError } from '../src/http/errors.ts'
import { ChatOperationsLive, ChatsAdapter } from '../src/layers/conversation.ts'
import { Models, type ModelPicker } from '../src/models.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'
import { Chats as LegacyChats } from '../src/services.ts'

/** A probe's own instances, which the Telegram ports' programs read (channel/turns.ts). */
type PortInstances = {
  readonly db: Db['Service']
  readonly chats: ChatDirectory
  readonly harness: PiHarness
  readonly budget: ModelBudget
  readonly models: ModelPicker
}

/**
 * The services the Telegram ports' programs read, over a probe's own instances: lane C's directory adapter and native
 * admission over its database and chat directory, and its budget and model picker as the routines lane's services wrap them.
 */
export const portServices = ({ db, chats, harness, budget, models }: PortInstances) => {
  // SAFETY: admission reads only Pi's harness from the instance input.
  const input = Layer.succeed(AgentInput, { harness } as AgentInputs)
  const core = Layer.mergeAll(Layer.succeed(Db, db), KeyedLock.layer, PiSessions.layer.pipe(Layer.provide(input)))
  return Layer.mergeAll(
    Layer.mergeAll(ChatsAdapter, ChatOperationsLive).pipe(
      Layer.provide(Layer.mergeAll(core, Layer.succeed(LegacyChats, chats), input)),
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
}
