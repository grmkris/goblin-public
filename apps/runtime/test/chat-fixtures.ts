import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Budget, type ModelBudget } from '../src/budget.ts'
import type { ChatDirectory } from '../src/chats/directory.ts'
import { toAppError } from '../src/http/errors.ts'
import { makeChatOperations } from '../src/chats/operations.ts'
import { ChatOperations } from '../src/chats/service.ts'
import { ChatsLive } from '../src/layers/conversation.ts'
import { Models, type ModelPicker } from '../src/models.ts'
import { FlowEvents } from '../src/observability/flows.ts'
import { KeyedLock } from '../src/observability/lock.ts'
import { PiSessions } from '../src/pi/sessions.ts'
import { Db } from '../src/runtime/db.ts'
import { AgentInput, type AgentInputs } from '../src/runtime/input.ts'

/** A probe's own instances, which the Telegram ports' programs read (channel/turns.ts). */
type PortInstances = {
  readonly db: Db['Service']
  readonly chats: ChatDirectory
  readonly harness: PiHarness
  readonly budget: ModelBudget
  readonly models: ModelPicker
}

/**
 * The services the Telegram ports' programs read, over a probe's own instances: lane C's chat directory and admission
 * over its database (admission also holding its chat directory's lock), its budget and model picker as the routines
 * lane's services wrap them, and Pi as its sessions. Flows are not recorded.
 */
export const portServices = ({ db, chats, harness, budget, models }: PortInstances) => {
  // SAFETY: admission reads only Pi's harness and the models it applied from the instance input; no routine answers.
  const input = Layer.succeed(AgentInput, { harness, applied: new Map() } as AgentInputs)
  const plans = Layer.mergeAll(
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
  const pi = PiSessions.layer.pipe(Layer.provide(input))
  const core = Layer.mergeAll(Layer.succeed(Db, db), KeyedLock.layer, pi, FlowEvents.noop, plans, input)
  const operations = Layer.effect(ChatOperations, makeChatOperations({ locks: chats }))
  return Layer.mergeAll(
    ChatsLive.pipe(Layer.provide(Layer.succeed(Db, db))),
    operations.pipe(Layer.provide(core)),
    plans,
    pi,
  )
}
