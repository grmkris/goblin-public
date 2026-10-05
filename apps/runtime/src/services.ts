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
import type { MainMemory } from './memory/memory.ts'
import type { SkillLearner } from './skills/learner.ts'
import type { SkillLibrary } from './skills/library.ts'
import type { TelegramChannel } from './channel/channel.ts'
import type { Entitlements } from './billing/gates.ts'
import type { Events } from './mcp/events.ts'
import type { EventStorage } from './mcp/events/store.ts'
import type { CapabilityProfiles } from './capabilities/profiles.ts'
import type { RoutineStore } from './routines/store.ts'
import type { RoutineRunStore } from './routines/runs.ts'
import type { RoutineUsage } from './routines/usage.ts'
import type { WorkspaceFeed } from './workspace/feed.ts'

/** The Agent DO's application services, provided once per object through a ManagedRuntime (agent.ts). */
export class Mcp extends Context.Service<Mcp, McpHost>()('purrable/Mcp') {}
export class Resident extends Context.Service<Resident, ResidentAuthority>()('purrable/Resident') {}
export class Conversations extends Context.Service<Conversations, ConversationRegistry>()('purrable/Conversations') {}
export class Budget extends Context.Service<Budget, ModelBudget>()('purrable/Budget') {}
export class Models extends Context.Service<Models, ModelPicker>()('purrable/Models') {}
export class Memory extends Context.Service<Memory, MainMemory>()('purrable/Memory') {}
export class Skills extends Context.Service<Skills, SkillLibrary>()('purrable/Skills') {}
export class Learner extends Context.Service<Learner, SkillLearner>()('purrable/Learner') {}
export class Channel extends Context.Service<Channel, TelegramChannel>()('purrable/Channel') {}
/** What each conversation switched off: the one gate every MCP, skills and subagent tool asks (ADR 0010). */
export class Capabilities extends Context.Service<Capabilities, CapabilityProfiles>()('purrable/Capabilities') {}
export class Routines extends Context.Service<Routines, RoutineStore>()('purrable/Routines') {}
export class RoutineRuns extends Context.Service<RoutineRuns, RoutineRunStore>()('purrable/RoutineRuns') {}
export class RoutineUsageProjection extends Context.Service<RoutineUsageProjection, RoutineUsage>()(
  'purrable/RoutineUsageProjection',
) {}
/** The owner's conversations and what each is doing, as one live feed. */
export class Workspace extends Context.Service<Workspace, WorkspaceFeed>()('purrable/Workspace') {}
export type AgentServices =
  | Entitlements
  | Events
  | EventStorage
  | Mcp
  | Resident
  | Conversations
  | Budget
  | Models
  | Memory
  | Skills
  | Learner
  | Channel
  | Capabilities
  | Routines
  | RoutineRuns
  | RoutineUsageProjection
  | Workspace

export const agentLayer = (services: {
  readonly host: McpHost
  readonly resident: ResidentAuthority
  readonly conversations: ConversationRegistry
  readonly budget: ModelBudget
  readonly models: ModelPicker
  readonly memory: MainMemory
  readonly skills: SkillLibrary
  readonly learner: SkillLearner
  readonly channel: TelegramChannel
  readonly capabilities: CapabilityProfiles
  readonly routines: RoutineStore
  readonly routineRuns: RoutineRunStore
  readonly routineUsage: RoutineUsage
  readonly workspace: WorkspaceFeed
}): Layer.Layer<Exclude<AgentServices, Entitlements | Events | EventStorage>> =>
  Layer.mergeAll(
    Layer.succeed(Mcp, services.host),
    Layer.succeed(Resident, services.resident),
    Layer.succeed(Conversations, services.conversations),
    Layer.succeed(Budget, services.budget),
    Layer.succeed(Models, services.models),
    Layer.succeed(Memory, services.memory),
    Layer.succeed(Skills, services.skills),
    Layer.succeed(Learner, services.learner),
    Layer.succeed(Channel, services.channel),
    Layer.succeed(Capabilities, services.capabilities),
    Layer.succeed(Routines, services.routines),
    Layer.succeed(RoutineRuns, services.routineRuns),
    Layer.succeed(RoutineUsageProjection, services.routineUsage),
    Layer.succeed(Workspace, services.workspace),
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
  yield* attempt(() => budget.require(now))
})
