import type { PiHarness } from 'agents/harness/pi'
import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite'
import * as Context from 'effect/Context'
import { ModelBudget, UsageStore } from '../budget.ts'
import { creditRates } from '../budget-credits.ts'
import { CapabilityProfiles, type PiTools } from '../capabilities/profiles.ts'
import { TelegramChannel } from '../channel/channel.ts'
import { nowMillis, nowSeconds } from '../clock.ts'
import { ChatDirectory } from '../chats/directory.ts'
import { ConversationRegistry, type ThreadKit } from '../conversations.ts'
import { ChatMover } from '../chats/mover.ts'
import { WorkspaceFeed } from '../workspace/feed.ts'
import { TopicRegistry } from '../topics/registry.ts'
import { PersonaRegistry } from '../personas/registry.ts'
import { PersonaInvocations } from '../personas/invocations.ts'
import { OrganizeReceipts } from '../organize/receipts.ts'
import { topicPorts } from '../topics/ports.ts'
import { AppRegistry } from '../apps/registry.ts'
import { appServices } from '../agent-apps/ports.ts'
import { CredentialCipher } from '../mcp/cipher.ts'
import { configuredServers } from '../mcp/config.ts'
import { CredentialStore } from '../mcp/credentials.ts'
import { bindEndpoints } from '../mcp/endpoints.ts'
import { GrantStore } from '../mcp/grants.ts'
import { McpApprovalStore } from '../mcp/approvals.ts'
import { installEventConsumers } from '../mcp/events/consumers.ts'
import { Events, McpEvents } from '../mcp/events.ts'
import { EventStorage, SqliteEventStore } from '../mcp/events/store.ts'
import { eventsHookToken, eventsHookUrl } from '../mcp/events/route-token.ts'
import { GrantDenied, Forbidden } from '../http/errors.ts'
import * as Layer from 'effect/Layer'
import { McpHost } from '../mcp/host.ts'
import { logEndpointsReset } from '../mcp/log.ts'
import { RegistryStore } from '../mcp/registries.ts'
import { AddedServerStore } from '../mcp/servers.ts'
import { ChatMemories, type MemoryDeps } from '../memory/memory.ts'
import { CheapModel } from '../memory/model.ts'
import { RunLedger } from '../telemetry/ledger.ts'
import { Inspector } from '../inspect/inspector.ts'
import { type AuxPurpose, auxReporter, mcpReporter } from '../telemetry/report.ts'
import { ModelChoiceStore, ModelPicker, memoryModelId, modelOptions } from '../models.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { ResidentAuthority } from '../resident.ts'
import { AppEngine, Approvals, Apps, Budget, Capabilities, Channel, Chats, Conversations, Files } from '../services.ts'
import { Home, Inspect, Invocations, Learner, Mcp, Memories, Models, Moves, Personas, Receipts } from '../services.ts'
import {
  Resident,
  Retrieval,
  RoutineRuns,
  Routines,
  RoutineUsageProjection,
  Skills,
  Topics,
  Workspace,
} from '../services.ts'
import { FileStore } from '../files/store.ts'
import { SkillLearner } from '../skills/learner.ts'
import { SkillLibrary } from '../skills/library.ts'
import { SqliteDraftLog, SqliteSkillState } from '../skills/store.ts'
import { runApplicationMigrations } from '../storage/migrations.ts'
import { Entitlements, type EntitlementPolicy } from '../billing/gates.ts'
import { RoutineStore } from '../routines/store.ts'
import { RoutineRunStore } from '../routines/runs.ts'
import { RoutineUsage, installRoutineUsage } from '../routines/usage.ts'
import * as Effect from 'effect/Effect'
import { AgentInput, type AgentInputs } from '../runtime/input.ts'
import { HomeService } from '../home/service.ts'
import { restoreHelperExecution } from '../pi/helper-execution.ts'
import { TranscriptIndex, piTranscripts } from '../retrieval/index.ts'
import { ChatRetrieval } from '../retrieval/service.ts'

/** What the agent's services are built from: its storage and env, and the Pi pieces its constructor made. */
type ComposeInput = AgentInputs
/** Sets a conversation's Pi tool filter (where subagents are switched off), leaving its extensions as they are. */
const retool = (harness: PiHarness) => async (session: string, tools: PiTools) => {
  const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
  await conversation?.configure({ tools }, BACKGROUND)
}
const authorizeEvents =
  (resident: ResidentAuthority, credentials: CredentialStore, store: SqliteEventStore, policy: EntitlementPolicy) =>
  async (serverId: string, name: string, argumentsJson: string): Promise<void> => {
    await Effect.runPromise(policy.require())
    resident.require(nowSeconds())
    if (credentials.status(serverId) !== 'connected')
      throw new Forbidden({ reason: 'event connection requires authorization' })
    if (!store.allows(serverId, name, argumentsJson)) throw new GrantDenied({ serverId, name })
  }
async function makeEvents(
  input: ComposeInput,
  host: McpHost,
  resident: ResidentAuthority,
  eventStore: SqliteEventStore,
  cipher: CredentialCipher,
): Promise<McpEvents> {
  const env = input.env
  const events = new McpEvents({
    manager: host.manager,
    store: eventStore,
    cipher,
    principal: input.userId,
    callback: eventsHookUrl(env.APP_URL, input.userId, await eventsHookToken(env.CREDENTIAL_KEY, input.userId)),
    wake: input.scheduleEvents,
    authorize: async () => {
      await Effect.runPromise(input.entitlements.require())
      resident.require(nowSeconds())
    },
  })
  events.register('routine-trigger', input.routineEvent)
  return events
}
async function makeRoutines(input: ComposeInput) {
  const db = drizzle(input.storage)
  const routines = new RoutineStore(db, input.userId)
  const routineRuns = new RoutineRunStore(db, input.userId)
  const routineUsage = new RoutineUsage(db, routineRuns, creditRates(input.env.MODEL_CREDIT_RATES), input.harness)
  await installRoutineUsage(input.harness, routineUsage, routineRuns)
  return { routines, routineRuns, routineUsage }
}
/** The conversation registry, the kept Apps (closed with their conversation), and the live workspace feed over both. */
function conversationServices(db: DrizzleSqliteDODatabase, input: ComposeInput, kit: ThreadKit) {
  const { harness } = input
  const conversations = new ConversationRegistry(db, harness, kit, nowSeconds())
  const { agentApps } = input
  const apps = new AppRegistry(
    db,
    harness,
    {
      info: (name) => agentApps.info(name),
      launch: (name) => agentApps.launch(name),
      rehome: (closed, to) => agentApps.rehome(closed, to),
    },
    kit.chats,
  )
  conversations.onChange((ids) => apps.closeWithConversations(ids, nowSeconds()))
  agentApps.onChange((name) => apps.agentChanged(name, nowSeconds()))
  const home = new HomeService(db, apps, agentApps)
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
      return undefined
    }
  })
  const workspace = new WorkspaceFeed(
    harness,
    { conversations, apps, home, topics, personas, invocations, receipts },
    kit.chats,
  )
  // Cross-Topic retrieval (ADR 0035): one transcript index, which a Move to thread also reassigns (ADR 0034).
  const transcripts = new TranscriptIndex(db, piTranscripts(harness), nowSeconds)
  const { thread, recall, capabilities, chats, memories } = kit
  const moves = new ChatMover({
    db,
    harness,
    chats,
    conversations,
    capabilities,
    memories,
    thread,
    recall,
    reassign: (session, from, chat) => transcripts.reassign(session, from, chat),
    ...input.moves,
  })
  // A move a restart interrupted finishes once the services are up again (ADR 0034); it never holds up the start.
  void moves.reconcile()
  return { conversations, apps, home, topics, personas, invocations, receipts, workspace, moves, transcripts }
}
async function makeHost(input: ComposeInput, db: DrizzleSqliteDODatabase) {
  const env = input.env
  const servers = configuredServers(env.MCP_SERVERS)
  const added = new AddedServerStore(db)
  const reset = bindEndpoints(db, [...servers, ...added.list()], nowSeconds())
  if (reset.length > 0) logEndpointsReset(reset)
  const skillState = new SqliteSkillState(db)
  const grants = new GrantStore(db)
  const cipher = await CredentialCipher.fromBase64(env.CREDENTIAL_KEY)
  const approvals = new McpApprovalStore(db, cipher)
  approvals.recover(nowMillis())
  const resident = new ResidentAuthority(db)
  const eventStore = new SqliteEventStore(db)
  const credentials = new CredentialStore(db, cipher)
  const host = new McpHost({
    servers,
    added,
    registries: new RegistryStore(db),
    credentials,
    authorizeEvents: authorizeEvents(resident, credentials, eventStore, input.entitlements),
    grants,
    authorizeTool: async (call, approvalId, dispatch, authorize) => {
      if (call.caller === 'human') return
      const policy = grants.policy({ serverId: call.serverId, capability: 'tool', name: call.name })
      if (approvalId !== undefined) {
        if (policy === undefined) throw new GrantDenied({ serverId: call.serverId, name: call.name })
        await approvals.assert({
          id: approvalId,
          call,
          version: () => grants.policy({ serverId: call.serverId, capability: 'tool', name: call.name })?.version,
          now: nowMillis(),
          dispatch,
          ...(authorize === undefined ? {} : { authorize }),
        })
      } else if (policy?.askFirst === true) {
        throw new Forbidden({ reason: 'Owner approval required for this exact call' })
      }
    },
    skillsEnabled: (serverId) => skillState.enabled(serverId),
    appUrl: env.APP_URL,
    fetch: input.mcpFetch,
    report: mcpReporter(input.telemetry),
  })
  return { host, cipher, resident, eventStore, skillState, grants, approvals }
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

/**
 * The first half of the start (compose.ts until the layer tree): migrations first, then every server's endpoint
 * binding is checked (a re-pointed server loses what it had), the MCP host and grants, budget and models, chats,
 * memory, capabilities and helper execution, routines, and the conversations, Topics and Apps over them.
 */
const startConversations = Effect.gen(function* () {
  const input = yield* AgentInput
  const { env, harness } = input
  runApplicationMigrations(input.storage)
  const db = drizzle(input.storage)
  const { host, cipher, resident, eventStore, skillState, grants, approvals } = yield* Effect.promise(() =>
    makeHost(input, db),
  )
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
  const chats = new ChatDirectory(db)
  const { recall } = input.memory
  const memories = makeMemories(input, { db, harness, model: cheap('memory'), chats })
  const capabilities = new CapabilityProfiles(db, input.subagentTools, retool(harness), chats)
  yield* Effect.promise(() => restoreHelperExecution(db, harness, input.helperExtensions, chats))
  // Apply the current complete delegation tool set to retained Pi filters.
  yield* Effect.promise(() => capabilities.retoolOnce('retool:subagent-config', nowSeconds()))
  const routineServices = yield* Effect.promise(() => makeRoutines(input))
  const kit = { thread: input.thread, recall, memories, namer: cheap('naming'), capabilities, chats }
  const conversations = conversationServices(db, input, kit)
  yield* Effect.promise(() => memories.activateConversations())
  return {
    input,
    db,
    cheap,
    mcp: { host, cipher, resident, eventStore, skillState, grants, approvals },
    services: { host, approvals, chats, resident, ...conversations, budget, models, memories, capabilities },
    routineServices,
  }
})

/**
 * The second half: skills and the learner, the Telegram channel, the agent apps' services, then Events and their
 * consumers. The Files, Inspect and Retrieval services are made last, as compose.ts made them.
 */
const startChannels = Effect.fn('LegacyLive.startChannels')(function* (
  started: Effect.Success<typeof startConversations>,
) {
  const { input, db, cheap, routineServices } = started
  const { host, cipher, resident, eventStore, skillState, grants } = started.mcp
  const { budget, capabilities, chats, conversations, transcripts } = started.services
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
  const channel = new TelegramChannel(db, cipher, input.scheduleReplies, input.telemetry, chats)
  input.agentApps.connect(
    appServices({
      host,
      resident,
      entitlements: input.entitlements,
      budget,
      model: cheap('app_llm'),
      channel,
      capabilities,
    }),
  )
  const events = yield* Effect.promise(() => makeEvents(input, host, resident, eventStore, cipher))
  installEventConsumers(events, channel, skills, input.pullTelegram)
  return {
    ...started.services,
    skills,
    learner,
    channel,
    ...routineServices,
    entitlements: input.entitlements,
    events,
    eventStore,
    files: new FileStore(input.storage.sql, input.env.FILES, () => input.userId),
    appEngine: input.agentApps,
    inspect: new Inspector(new RunLedger(db), conversations, input.harness),
    retrieval: new ChatRetrieval(transcripts, cheap('retrieval'), nowSeconds),
  }
})

/** The services.ts tags, which the layer tree provides from this layer until each lane's own layer replaces one. */
type LegacyServices =
  | Mcp
  | Approvals
  | Resident
  | Conversations
  | Topics
  | Personas
  | Invocations
  | Receipts
  | Moves
  | Chats
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
  | Home
  | Entitlements
  | Events
  | EventStorage
  | Files
  | AppEngine
  | Inspect
  | Retrieval

/** The legacy service tags over the started instances; one instance each, as compose.ts provided them. */
const legacyContext = (started: Effect.Success<ReturnType<typeof startChannels>>) =>
  Context.mergeAll(
    Mcp.context(started.host),
    Approvals.context(started.approvals),
    Resident.context(started.resident),
    Conversations.context(started.conversations),
    Topics.context(started.topics),
    Personas.context(started.personas),
    Invocations.context(started.invocations),
    Receipts.context(started.receipts),
    Moves.context(started.moves),
    Chats.context(started.chats),
    Budget.context(started.budget),
    Models.context(started.models),
    Memories.context(started.memories),
    Skills.context(started.skills),
    Learner.context(started.learner),
    Channel.context(started.channel),
    Capabilities.context(started.capabilities),
    Routines.context(started.routines),
    RoutineRuns.context(started.routineRuns),
    RoutineUsageProjection.context(started.routineUsage),
    Workspace.context(started.workspace),
    Apps.context(started.apps),
    Home.context(started.home),
    Entitlements.context(started.entitlements),
    Events.context(started.events),
    EventStorage.context(started.eventStore),
    Files.context(started.files),
    AppEngine.context(started.appEngine),
    Inspect.context(started.inspect),
    Retrieval.context(started.retrieval),
  )

/**
 * The agent's legacy services (services.ts tags) over its SQLite, built once per runtime: compose.ts's start as one
 * layer, step for step in its order, until each step moves into its owning lane's layer. A step that failed rejects the
 * build with its own error, as compose.ts's promise did.
 */
export const LegacyLive: Layer.Layer<LegacyServices, never, AgentInput> = Layer.effectContext(
  startConversations.pipe(Effect.flatMap(startChannels), Effect.map(legacyContext)),
)
