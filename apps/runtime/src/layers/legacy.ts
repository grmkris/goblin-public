import * as Context from 'effect/Context'
import { ProfilesInstance } from '../capabilities/profiles.ts'
import { nowSeconds } from '../clock.ts'
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
import * as Layer from 'effect/Layer'
import { MemoriesInstance } from '../memory/memory.ts'
import { CheapModels } from '../memory/model.ts'
import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import { modelOptions } from '../models.ts'
import { AppEngine, Apps, Chats, Conversations, Files, Home, Invocations, Moves } from '../services.ts'
import { Personas, Receipts, Topics, Workspace } from '../services.ts'
import { FileStore } from '../files/store.ts'
import { runApplicationMigrations } from '../storage/migrations.ts'
import { Entitlements } from '../billing/gates.ts'
import * as Effect from 'effect/Effect'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { HomeService } from '../home/service.ts'
import { restoreHelperExecution } from '../pi/helper-execution.ts'
import { TranscriptsInstance } from '../retrieval/index.ts'

// The legacy start, step for step in its order: each step is one layer, and `layers/index.ts` builds them in this
// order over the core layer, each over everything before it. A step that awaits holds up every step after it; the one
// that does not (the mover's reconcile) says so. A failed step rejects the build with its own error, so the runtime is
// made again on the next call (agent.ts). The steps move into their owning lanes' layers one by one.

/** 1. The application tables' migrations, before anything reads them. */
export const MigrationsStep: Layer.Layer<never, never, AgentInput> = Layer.effectDiscard(
  AgentInput.useSync((input) => runApplicationMigrations(input.storage)),
)

/** 4. The chat directory: every chat id and its current Pi session. */
export const ChatsStep: Layer.Layer<Chats, never, Db> = Layer.effect(
  Chats,
  Db.useSync((db) => new ChatDirectory(db)),
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

/** 10. The conversation registry (main is registered here, once). */
export const ConversationsStep: Layer.Layer<
  Conversations,
  never,
  AgentInput | Db | Chats | MemoriesInstance | ProfilesInstance | CheapModels
> = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const cheap = yield* CheapModels
    const kit = {
      thread: input.thread,
      recall: input.memory.recall,
      memories: yield* MemoriesInstance,
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
  AgentInput | Db | Chats | Conversations | MemoriesInstance | ProfilesInstance | Apps
> = Layer.effectContext(
  Effect.gen(function* () {
    const input = yield* AgentInput
    const db = yield* Db
    const chats = yield* Chats
    const conversations = yield* Conversations
    const apps = yield* Apps
    const kit = { memories: yield* MemoriesInstance, capabilities: yield* ProfilesInstance, chats }
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

/**
 * 14. Move to thread. A move a restart interrupted finishes once the services are up again (ADR 0034); it never holds
 * up the start, so its reconcile runs on while the steps after this one are built.
 */
export const MovesStep: Layer.Layer<
  Moves,
  never,
  AgentInput | Db | Chats | Conversations | ProfilesInstance | MemoriesInstance | TranscriptsInstance
> = Layer.effect(
  Moves,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const transcripts = yield* TranscriptsInstance
    const moves = new ChatMover({
      db: yield* Db,
      harness: input.harness,
      chats: yield* Chats,
      conversations: yield* Conversations,
      capabilities: yield* ProfilesInstance,
      memories: yield* MemoriesInstance,
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

/**
 * 19. Last, the files, the plan policy and the agent's apps. The agent apps are connected to the agent's services by
 * lane A's layer (agent-apps/live.ts), after this whole start.
 */
export const RestStep: Layer.Layer<Files | Entitlements | AppEngine, never, AgentInput> = Layer.effectContext(
  AgentInput.useSync((input) =>
    Context.mergeAll(
      Files.context(new FileStore(input.storage.sql, input.env.FILES, () => input.userId)),
      Entitlements.context(input.entitlements),
      AppEngine.context(input.agentApps),
    ),
  ),
)

/** What the legacy steps provide: the services.ts tags and the start's own, until each lane's layer replaces one. */
export type LegacyServices =
  | Layer.Success<typeof ChatsStep>
  | Layer.Success<typeof ConversationsStep>
  | Layer.Success<typeof AppsStep>
  | Layer.Success<typeof DelegationStep>
  | Layer.Success<typeof MovesStep>
  | Layer.Success<typeof RestStep>
