import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type AppError, toAppError } from './http/errors.ts'
import type { ModelBudget } from './budget.ts'
import type { ModelPicker } from './models.ts'
import type { McpHost } from './mcp/host.ts'
import type { ResidentAuthority } from './resident.ts'
import type { ConversationRegistry } from './conversations.ts'

/** The Agent DO's application services, provided once per object through a ManagedRuntime (agent.ts). */
export class Mcp extends Context.Service<Mcp, McpHost>()('purrable/Mcp') {}
export class Resident extends Context.Service<Resident, ResidentAuthority>()('purrable/Resident') {}
export class Conversations extends Context.Service<Conversations, ConversationRegistry>()('purrable/Conversations') {}
export class Budget extends Context.Service<Budget, ModelBudget>()('purrable/Budget') {}
export class Models extends Context.Service<Models, ModelPicker>()('purrable/Models') {}
export type AgentServices = Mcp | Resident | Conversations | Budget | Models

export const agentLayer = (
  host: McpHost,
  resident: ResidentAuthority,
  conversations: ConversationRegistry,
  budget: ModelBudget,
  models: ModelPicker,
): Layer.Layer<AgentServices> =>
  Layer.mergeAll(
    Layer.succeed(Mcp, host),
    Layer.succeed(Resident, resident),
    Layer.succeed(Conversations, conversations),
    Layer.succeed(Budget, budget),
    Layer.succeed(Models, models),
  )

/** Wrap a plain async step so its failure lands in the typed `AppError` channel. */
export const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({ try: run, catch: toAppError })

export const attemptSync = <A>(run: () => A): Effect.Effect<A, AppError> => Effect.try({ try: run, catch: toAppError })

export const nowSecondsEffect: Effect.Effect<number> = Effect.map(Clock.currentTimeMillis, (millis) =>
  Math.floor(millis / 1000),
)

/** Fails with `ResidentInactive` unless the owner's resident authority is current. */
export const requireResident: Effect.Effect<void, AppError, Resident> = Effect.gen(function* () {
  const resident = yield* Resident
  const now = yield* nowSecondsEffect
  yield* attemptSync(() => resident.require(now))
})

/** Fails with `BudgetExhausted` once the user's agent has spent today's model budget. */
export const requireBudget: Effect.Effect<void, AppError, Budget> = Effect.gen(function* () {
  const budget = yield* Budget
  const now = yield* nowSecondsEffect
  yield* attemptSync(() => budget.require(now))
})
