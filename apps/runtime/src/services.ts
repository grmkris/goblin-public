import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type AppError, toAppError } from './http/errors.ts'
import type { ModelBudget } from './budget.ts'
import type { ModelPicker } from './models.ts'
import type { McpHost } from './mcp/host.ts'
import type { ResidentAuthority } from './resident.ts'
import type { ChatDirectory } from './chats/directory.ts'
import type { ConversationRegistry } from './conversations.ts'
import type { ChatMemories } from './memory/memory.ts'
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
import type { AppRegistry } from './apps/registry.ts'
import type { FileStore } from './files/store.ts'
import type { AgentApps } from './agent-apps/engine.ts'
import type { Inspector } from './inspect/inspector.ts'
import type { HomeService } from './home/service.ts'
import type { McpApprovalStore } from './mcp/approvals.ts'
import type { TopicRegistry } from './topics/registry.ts'
import type { PersonaRegistry } from './personas/registry.ts'
import type { PersonaInvocations } from './personas/invocations.ts'
import type { OrganizeReceipts } from './organize/receipts.ts'
import type { ChatRetrieval } from './retrieval/service.ts'

/** The Agent DO's application services, provided once per object through a ManagedRuntime (agent.ts). */
export class Mcp extends Context.Service<Mcp, McpHost>()('goblin/Mcp') {}
export class Approvals extends Context.Service<Approvals, McpApprovalStore>()('goblin/Approvals') {}
export class Resident extends Context.Service<Resident, ResidentAuthority>()('goblin/Resident') {}
export class Chats extends Context.Service<Chats, ChatDirectory>()('goblin/Chats') {}
export class Conversations extends Context.Service<Conversations, ConversationRegistry>()('goblin/Conversations') {}
/** The owner's Topics (ADR 0032): each with one Conversation; Personal holds Main. */
export class Topics extends Context.Service<Topics, TopicRegistry>()('goblin/Topics') {}
/** The owner's Personas (ADR 0033), which Persona answered which message, and what organizing changed. */
export class Personas extends Context.Service<Personas, PersonaRegistry>()('goblin/Personas') {}
export class Invocations extends Context.Service<Invocations, PersonaInvocations>()('goblin/Invocations') {}
export class Receipts extends Context.Service<Receipts, OrganizeReceipts>()('goblin/Receipts') {}
export class Budget extends Context.Service<Budget, ModelBudget>()('goblin/Budget') {}
export class Models extends Context.Service<Models, ModelPicker>()('goblin/Models') {}
/** Each Topic Conversation's memory (ADR 0032). */
export class Memories extends Context.Service<Memories, ChatMemories>()('goblin/Memories') {}
export class Skills extends Context.Service<Skills, SkillLibrary>()('goblin/Skills') {}
export class Learner extends Context.Service<Learner, SkillLearner>()('goblin/Learner') {}
export class Channel extends Context.Service<Channel, TelegramChannel>()('goblin/Channel') {}
/** What each conversation switched off: the one gate every MCP, skills and subagent tool asks (ADR 0010). */
export class Capabilities extends Context.Service<Capabilities, CapabilityProfiles>()('goblin/Capabilities') {}
export class Routines extends Context.Service<Routines, RoutineStore>()('goblin/Routines') {}
export class RoutineRuns extends Context.Service<RoutineRuns, RoutineRunStore>()('goblin/RoutineRuns') {}
export class RoutineUsageProjection extends Context.Service<RoutineUsageProjection, RoutineUsage>()(
  'goblin/RoutineUsageProjection',
) {}
/** The owner's conversations and what each is doing, as one live feed. */
export class Workspace extends Context.Service<Workspace, WorkspaceFeed>()('goblin/Workspace') {}
/** The owner's Apps (ADRs 0020, 0021): MCP Apps kept per call and agent apps with a view. */
export class Apps extends Context.Service<Apps, AppRegistry>()('goblin/Apps') {}
export class Files extends Context.Service<Files, FileStore>()('goblin/Files') {}
/** The agent's apps (ADR 0021): their builds, calls and views. */
export class AppEngine extends Context.Service<AppEngine, AgentApps>()('goblin/AppEngine') {}
/** Read-only inspection of the agent's conversations and runs (ADR 0024). */
export class Inspect extends Context.Service<Inspect, Inspector>()('goblin/Inspect') {}
export class Home extends Context.Service<Home, HomeService>()('goblin/Home') {}
/** Cross-Topic retrieval (ADR 0035): the transcript index, `search_chats` and automatic sources. */
export class Retrieval extends Context.Service<Retrieval, ChatRetrieval>()('goblin/Retrieval') {}
export type AgentServices =
  | Entitlements
  | Events
  | EventStorage
  | Mcp
  | Approvals
  | Resident
  | Chats
  | Conversations
  | Topics
  | Personas
  | Invocations
  | Receipts
  | Budget
  | Models
  | Memories
  | Skills
  | Learner
  | Channel
  | Capabilities
  | Routines
  | RoutineRuns
  | RoutineUsageProjection
  | Workspace
  | Apps
  | Files
  | AppEngine
  | Inspect
  | Home
  | Retrieval

export const agentLayer = (services: {
  readonly host: McpHost
  readonly approvals: McpApprovalStore
  readonly resident: ResidentAuthority
  readonly conversations: ConversationRegistry
  readonly topics: TopicRegistry
  readonly personas: PersonaRegistry
  readonly invocations: PersonaInvocations
  readonly receipts: OrganizeReceipts
  readonly chats: ChatDirectory
  readonly budget: ModelBudget
  readonly models: ModelPicker
  readonly memories: ChatMemories
  readonly skills: SkillLibrary
  readonly learner: SkillLearner
  readonly channel: TelegramChannel
  readonly capabilities: CapabilityProfiles
  readonly routines: RoutineStore
  readonly routineRuns: RoutineRunStore
  readonly routineUsage: RoutineUsage
  readonly workspace: WorkspaceFeed
  readonly apps: AppRegistry
  readonly home: HomeService
}): Layer.Layer<
  Exclude<AgentServices, Entitlements | Events | EventStorage | Files | AppEngine | Inspect | Retrieval>
> =>
  Layer.mergeAll(
    Layer.succeed(Mcp, services.host),
    Layer.succeed(Approvals, services.approvals),
    Layer.succeed(Resident, services.resident),
    Layer.succeed(Conversations, services.conversations),
    Layer.succeed(Topics, services.topics),
    Layer.succeed(Personas, services.personas),
    Layer.succeed(Invocations, services.invocations),
    Layer.succeed(Receipts, services.receipts),
    Layer.succeed(Chats, services.chats),
    Layer.succeed(Budget, services.budget),
    Layer.succeed(Models, services.models),
    Layer.succeed(Memories, services.memories),
    Layer.succeed(Skills, services.skills),
    Layer.succeed(Learner, services.learner),
    Layer.succeed(Channel, services.channel),
    Layer.succeed(Capabilities, services.capabilities),
    Layer.succeed(Routines, services.routines),
    Layer.succeed(RoutineRuns, services.routineRuns),
    Layer.succeed(RoutineUsageProjection, services.routineUsage),
    Layer.succeed(Workspace, services.workspace),
    Layer.succeed(Apps, services.apps),
    Layer.succeed(Home, services.home),
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
