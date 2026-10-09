import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Context from 'effect/Context'
import { ModelBudget, UsageStore } from '../budget.ts'
import { creditRates } from '../budget-credits.ts'
import { ProfilesInstance } from '../capabilities/profiles.ts'
import { TelegramChannel } from '../channel/channel.ts'
import { nowMillis, nowSeconds } from '../clock.ts'
import { ChatDirectory } from '../chats/directory.ts'
import { ConversationRegistry } from '../conversations.ts'
import { ChatMover } from '../chats/mover.ts'
import { WorkspaceFeed } from '../workspace/feed.ts'
import { TopicRegistry } from '../topics/registry.ts'
import { PersonaRegistry } from '../personas/registry.ts'
import { PersonaInvocations } from '../personas/invocations.ts'
import { OrganizeReceipts } from '../organize/receipts.ts'
import { topicPorts } from '../topics/ports.ts'
import { AppRegistry } from '../apps/registry.ts'
import { Cipher } from '../mcp/cipher.ts'
import { GrantStore } from '../mcp/grants.ts'
import * as Layer from 'effect/Layer'
import { McpHostInstance } from '../mcp/host.ts'
import { ChatMemories, type MemoryDeps } from '../memory/memory.ts'
import { CheapModel } from '../memory/model.ts'
import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import { type AuxPurpose, auxReporter } from '../telemetry/report.ts'
import { ModelChoiceStore, ModelPicker, memoryModelId, modelOptions } from '../models.ts'
import { AppEngine, Apps, Budget, Channel, Chats, Conversations, Files, Home } from '../services.ts'
import { Invocations, Learner, Memories, Models, Moves, Personas, Receipts } from '../services.ts'
import { Retrieval, RoutineRuns, Routines, RoutineUsageProjection, Skills, Topics, Workspace } from '../services.ts'
import { FileStore } from '../files/store.ts'
import { SkillLearner } from '../skills/learner.ts'
import { SkillLibrary } from '../skills/library.ts'
import { SqliteDraftLog, SqliteSkillState } from '../skills/store.ts'
import { runApplicationMigrations } from '../storage/migrations.ts'
import { Entitlements } from '../billing/gates.ts'
import { RoutineStore } from '../routines/store.ts'
import { RoutineRunStore } from '../routines/runs.ts'
import { RoutineUsage, installRoutineUsage } from '../routines/usage.ts'
import * as Effect from 'effect/Effect'
import { Db } from '../runtime/db.ts'
import { AgentInput, type AgentInputs } from '../runtime/input.ts'
import { HomeService } from '../home/service.ts'
import { restoreHelperExecution } from '../pi/helper-execution.ts'
import { TranscriptIndex, piTranscripts } from '../retrieval/index.ts'
import { ChatRetrieval } from '../retrieval/service.ts'

// The legacy start, step for step in its order: each step is one layer, and `layers/index.ts` builds them in this
// order over the core layer, each over everything before it. A step that awaits holds up every step after it; the one
// that does not (the mover's reconcile) says so. A failed step rejects the build with its own error, so the runtime is
// made again on the next call (agent.ts). The steps move into their owning lanes' layers one by one.

/** What the agent's services are built from: its storage and env, and the Pi pieces its constructor made. */
type ComposeInput = AgentInputs
/** The cheap model for one housekeeping purpose, its tokens counted in the legacy budget. */
class CheapModels extends Context.Service<CheapModels, (purpose: AuxPurpose) => CheapModel>()(
  'goblin/legacy/CheapModels',
) {}
/** The one transcript index, which retrieval reads and a Move to thread reassigns. */
class Transcripts extends Context.Service<Transcripts, TranscriptIndex>()('goblin/legacy/Transcripts') {}

async function makeRoutines(input: ComposeInput, db: DrizzleSqliteDODatabase) {
  const routines = new RoutineStore(db, input.userId)
  const routineRuns = new RoutineRunStore(db, input.userId)
  const routineUsage = new RoutineUsage(db, routineRuns, creditRates(input.env.MODEL_CREDIT_RATES), input.harness)
  await installRoutineUsage(input.harness, routineUsage, routineRuns)
  return { routines, routineRuns, routineUsage }
}
function makeBudgets(input: ComposeInput, db: DrizzleSqliteDODatabase) {
  const env = input.env
  const budget = new ModelBudget(
    new UsageStore(db),
    async () => (await Effect.runPromise(input.entitlements.require())).dailyCredits,
    creditRates(env.MODEL_CREDIT_RATES),
  )
  return budget
}

/** Each Topic Conversation's memory, with the memory extensions it turns on and the native fixture's fold override. */
function makeMemories(input: ComposeInput, deps: MemoryDeps): ChatMemories {
  const fold = Number(input.env.MEMORY_FOLD_TOKENS ?? Number.NaN)
  const options = Number.isFinite(fold) ? { foldTokens: fold } : {}
  return new ChatMemories(deps, options, [input.memory.memory, input.memory.recall])
}

/** 1. The application tables' migrations, before anything reads them. */
export const MigrationsStep: Layer.Layer<never, never, AgentInput> = Layer.effectDiscard(
  AgentInput.useSync((input) => runApplicationMigrations(input.storage)),
)

/** 3. The model budget and picker, and the cheap model each housekeeping purpose calls. */
export const BudgetStep: Layer.Layer<Budget | Models | CheapModels, never, AgentInput | Db> = Layer.effectContext(
  Effect.gen(function* () {
    const input = yield* AgentInput
    const db = yield* Db
    const { env } = input
    const budget = makeBudgets(input, db)
    const options = modelOptions(env.MODELS, env.MODEL_ID)
    const models = new ModelPicker(new ModelChoiceStore(db), options)
    const cheapModelId = memoryModelId(env.MEMORY_MODEL, options)
    const cheap = (purpose: AuxPurpose) =>
      new CheapModel(
        input.pi.models,
        cheapModelId,
        (use) => budget.record(use, nowSeconds(), cheapModelId),
        auxReporter(input.telemetry, purpose),
      )
    return Context.mergeAll(Budget.context(budget), Models.context(models), CheapModels.context(cheap))
  }),
)

/** 4. The chat directory: every chat id and its current Pi session. */
export const ChatsStep: Layer.Layer<Chats, never, Db> = Layer.effect(
  Chats,
  Db.useSync((db) => new ChatDirectory(db)),
)

/** 5. Each Topic Conversation's memory. */
export const MemoryStep: Layer.Layer<Memories, never, AgentInput | Db | Chats | CheapModels> = Layer.effect(
  Memories,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const db = yield* Db
    const chats = yield* Chats
    const cheap = yield* CheapModels
    return makeMemories(input, { db, harness: input.harness, model: cheap('memory'), chats })
  }),
)

/** 7. Each helper conversation runs with the execution extensions the agent has now. */
export const HelperExecutionStep: Layer.Layer<never, never, AgentInput | Db | Chats> = Layer.effectDiscard(
  Effect.gen(function* () {
    const input = yield* AgentInput
    const db = yield* Db
    const chats = yield* Chats
    yield* Effect.promise(() => restoreHelperExecution(db, input.harness, input.helperExtensions, chats))
  }),
)

/** 9. The routine stores, and the usage projection subscribed to Pi's commits (a snapshot of each live run first). */
export const RoutinesStep: Layer.Layer<Routines | RoutineRuns | RoutineUsageProjection, never, AgentInput | Db> =
  Layer.effectContext(
    Effect.gen(function* () {
      const input = yield* AgentInput
      const db = yield* Db
      const { routines, routineRuns, routineUsage } = yield* Effect.promise(() => makeRoutines(input, db))
      return Context.mergeAll(
        Routines.context(routines),
        RoutineRuns.context(routineRuns),
        RoutineUsageProjection.context(routineUsage),
      )
    }),
  )

/** 10. The conversation registry (main is registered here, once). */
export const ConversationsStep: Layer.Layer<
  Conversations,
  never,
  AgentInput | Db | Chats | Memories | ProfilesInstance | CheapModels
> = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const cheap = yield* CheapModels
    const kit = {
      thread: input.thread,
      recall: input.memory.recall,
      memories: yield* Memories,
      namer: cheap('naming'),
      capabilities: yield* ProfilesInstance,
      chats: yield* Chats,
    }
    return new ConversationRegistry(yield* Db, input.harness, kit, nowSeconds())
  }),
)

/** 11. The kept Apps, closed with their conversation and told about each agent app's change. */
export const AppsStep: Layer.Layer<Apps, never, AgentInput | Db | Chats | Conversations> = Layer.effect(
  Apps,
  Effect.gen(function* () {
    const { harness, agentApps } = yield* AgentInput
    const conversations = yield* Conversations
    const apps = new AppRegistry(
      yield* Db,
      harness,
      {
        info: (name) => agentApps.info(name),
        launch: (name) => agentApps.launch(name),
        rehome: (closed, to) => agentApps.rehome(closed, to),
      },
      yield* Chats,
    )
    conversations.onChange((ids) => apps.closeWithConversations(ids, nowSeconds()))
    agentApps.onChange((name) => apps.agentChanged(name, nowSeconds()))
    return apps
  }),
)

/** 12. Home, the Topic and Persona registries, the invocations, the receipts and a workspace feed over them. */
export const DelegationStep: Layer.Layer<
  Home | Topics | Personas | Invocations | Receipts | Workspace,
  never,
  AgentInput | Db | Chats | Conversations | Memories | ProfilesInstance | Apps
> = Layer.effectContext(
  Effect.gen(function* () {
    const input = yield* AgentInput
    const db = yield* Db
    const chats = yield* Chats
    const conversations = yield* Conversations
    const apps = yield* Apps
    const kit = { memories: yield* Memories, capabilities: yield* ProfilesInstance, chats }
    const home = new HomeService(db, apps, input.agentApps)
    const topics = new TopicRegistry(db, topicPorts(db, conversations, kit))
    const personas = new PersonaRegistry(
      db,
      modelOptions(input.env.MODELS, input.env.MODEL_ID).map((option) => option.id),
    )
    const invocations = new PersonaInvocations(db)
    const receipts = new OrganizeReceipts(db, (kind, target) => {
      try {
        return (kind.startsWith('topic.') ? topics : personas).get(Number(target)).revision
      } catch {
        // expected: a Topic or Persona deleted since has no revision for the receipt to compare
        return undefined
      }
    })
    const workspace = new WorkspaceFeed(
      input.harness,
      { conversations, apps, home, topics, personas, invocations, receipts },
      chats,
    )
    return Context.mergeAll(
      Home.context(home),
      Topics.context(topics),
      Personas.context(personas),
      Invocations.context(invocations),
      Receipts.context(receipts),
      Workspace.context(workspace),
    )
  }),
)

/** 13. Cross-Topic retrieval's one transcript index (ADR 0035), which a Move to thread also reassigns (ADR 0034). */
export const TranscriptsStep: Layer.Layer<Transcripts, never, AgentInput | Db> = Layer.effect(
  Transcripts,
  Effect.gen(function* () {
    const { harness } = yield* AgentInput
    return new TranscriptIndex(yield* Db, piTranscripts(harness), nowSeconds)
  }),
)

/**
 * 14. Move to thread. A move a restart interrupted finishes once the services are up again (ADR 0034); it never holds
 * up the start, so its reconcile runs on while the steps after this one are built.
 */
export const MovesStep: Layer.Layer<
  Moves,
  never,
  AgentInput | Db | Chats | Conversations | ProfilesInstance | Memories | Transcripts
> = Layer.effect(
  Moves,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const transcripts = yield* Transcripts
    const moves = new ChatMover({
      db: yield* Db,
      harness: input.harness,
      chats: yield* Chats,
      conversations: yield* Conversations,
      capabilities: yield* ProfilesInstance,
      memories: yield* Memories,
      thread: input.thread,
      recall: input.memory.recall,
      reassign: (session, from, chat) => transcripts.reassign(session, from, chat),
      ...input.moves,
    })
    moves.reconcile().catch((error: unknown) => {
      writeLine('error', { event: 'failure', where: 'moves.reconcile', 'error.type': safeErrorType(error) })
    })
    return moves
  }),
)

/** 15. Every Topic Conversation without memory yet is given it. */
export const ActivateMemoriesStep: Layer.Layer<never, never, Memories> = Layer.effectDiscard(
  Effect.flatMap(Memories, (memories) => Effect.promise(() => memories.activateConversations())),
)

/** 16. Skills from the owner's MCP libraries, and the learner that proposes new ones. */
export const SkillsStep: Layer.Layer<Skills | Learner, never, AgentInput | Db | McpHostInstance | CheapModels> =
  Layer.effectContext(
    Effect.gen(function* () {
      const input = yield* AgentInput
      const db = yield* Db
      const host = yield* McpHostInstance
      const skillState = new SqliteSkillState(db)
      const grants = new GrantStore(db)
      const cheap = yield* CheapModels
      const skills = new SkillLibrary(host.manager, skillState, nowMillis)
      const learner = new SkillLearner({
        drafts: new SqliteDraftLog(db),
        harness: input.harness,
        manager: host.manager,
        library: skills,
        state: skillState,
        model: cheap('skill'),
        allows: (serverId, name) => grants.allows({ serverId, capability: 'tool', name }),
        now: nowMillis,
      })
      return Context.mergeAll(Skills.context(skills), Learner.context(learner))
    }),
  )

/** 17. The Telegram channel. */
export const ChannelStep: Layer.Layer<Channel, never, AgentInput | Db | Cipher | Chats> = Layer.effect(
  Channel,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const cipher = yield* Cipher
    return new TelegramChannel(yield* Db, cipher, input.scheduleReplies, input.telemetry, yield* Chats)
  }),
)

/**
 * 19. Last, the files, the plan policy, the agent's apps and retrieval. The agent apps are connected to the agent's
 * services by lane A's layer (agent-apps/live.ts), after this whole start.
 */
export const RestStep: Layer.Layer<
  Files | Entitlements | AppEngine | Retrieval,
  never,
  AgentInput | Transcripts | CheapModels
> = Layer.effectContext(
  Effect.gen(function* () {
    const input = yield* AgentInput
    const cheap = yield* CheapModels
    return Context.mergeAll(
      Files.context(new FileStore(input.storage.sql, input.env.FILES, () => input.userId)),
      Entitlements.context(input.entitlements),
      AppEngine.context(input.agentApps),
      Retrieval.context(new ChatRetrieval(yield* Transcripts, cheap('retrieval'), nowSeconds)),
    )
  }),
)

/** What the legacy steps provide: the services.ts tags and the start's own, until each lane's layer replaces one. */
export type LegacyServices =
  | Layer.Success<typeof BudgetStep>
  | Layer.Success<typeof ChatsStep>
  | Layer.Success<typeof MemoryStep>
  | Layer.Success<typeof RoutinesStep>
  | Layer.Success<typeof ConversationsStep>
  | Layer.Success<typeof AppsStep>
  | Layer.Success<typeof DelegationStep>
  | Layer.Success<typeof TranscriptsStep>
  | Layer.Success<typeof MovesStep>
  | Layer.Success<typeof SkillsStep>
  | Layer.Success<typeof ChannelStep>
  | Layer.Success<typeof RestStep>
