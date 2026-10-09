import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { ModelBudget, UsageStore } from './budget.ts'
import { creditRates } from './budget-credits.ts'
import { CapabilityProfiles, type PiTools } from './capabilities/profiles.ts'
import { TelegramChannel } from './channel/channel.ts'
import { nowMillis, nowSeconds } from './clock.ts'
import { ChatDirectory } from './chats/directory.ts'
import { ConversationRegistry, type ThreadKit } from './conversations.ts'
import { WorkspaceFeed } from './workspace/feed.ts'
import { TopicRegistry } from './topics/registry.ts'
import { AppRegistry } from './apps/registry.ts'
import type { AgentApps } from './agent-apps/engine.ts'
import { appServices } from './agent-apps/ports.ts'
import type { RuntimeEnv } from './env.ts'
import { CredentialCipher } from './mcp/cipher.ts'
import { configuredServers } from './mcp/config.ts'
import { CredentialStore } from './mcp/credentials.ts'
import { bindEndpoints } from './mcp/endpoints.ts'
import { GrantStore } from './mcp/grants.ts'
import { McpApprovalStore } from './mcp/approvals.ts'
import { installEventConsumers } from './mcp/events/consumers.ts'
import { Events, McpEvents } from './mcp/events.ts'
import { EventStorage, SqliteEventStore } from './mcp/events/store.ts'
import { eventsHookToken, eventsHookUrl } from './mcp/events/route-token.ts'
import { GrantDenied, Forbidden } from './http/errors.ts'
import * as Layer from 'effect/Layer'
import { McpHost } from './mcp/host.ts'
import { logEndpointsReset } from './mcp/log.ts'
import { RegistryStore } from './mcp/registries.ts'
import { AddedServerStore } from './mcp/servers.ts'
import { MainMemory } from './memory/memory.ts'
import { CheapModel } from './memory/model.ts'
import type { RunTelemetry } from './telemetry/events.ts'
import { RunLedger } from './telemetry/ledger.ts'
import { Inspector } from './inspect/inspector.ts'
import { type AuxPurpose, auxReporter, mcpReporter } from './telemetry/report.ts'
import { ModelChoiceStore, ModelPicker, memoryModelId, modelOptions } from './models.ts'
import { BACKGROUND, conversationId } from './pi/context.ts'
import type { PiModels } from './pi/harness.ts'
import type { memoryExtensions } from './pi/memory.ts'
import { ResidentAuthority } from './resident.ts'
import { type AgentServices, AppEngine, Files, Inspect, agentLayer } from './services.ts'
import { FileStore } from './files/store.ts'
import { SkillLearner } from './skills/learner.ts'
import { SkillLibrary } from './skills/library.ts'
import { SqliteDraftLog, SqliteSkillState } from './skills/store.ts'
import { runApplicationMigrations } from './storage/migrations.ts'
import { Entitlements, type EntitlementPolicy } from './billing/gates.ts'
import { RoutineStore } from './routines/store.ts'
import { RoutineRunStore } from './routines/runs.ts'
import { RoutineUsage, installRoutineUsage } from './routines/usage.ts'
import * as Effect from 'effect/Effect'
import type { EventHandler } from './mcp/events/dispatcher.ts'
import { HomeService } from './home/service.ts'
import { restoreHelperExecution } from './pi/helper-execution.ts'

/** What the agent's services are built from: its storage and env, and the Pi pieces its constructor made. */
export type ComposeInput = {
  readonly storage: DurableObjectStorage
  readonly env: RuntimeEnv
  readonly harness: PiHarness
  readonly pi: PiModels
  readonly thread: Extension
  readonly memory: ReturnType<typeof memoryExtensions>
  /** The subagent tools, which Pi's tool filter removes where subagents are switched off. */
  readonly subagentTools: readonly ToolRegistration[]
  readonly helperExtensions: readonly Extension[]
  /** Schedules the Telegram replies alarm. */
  readonly scheduleReplies: () => void
  readonly userId: string
  readonly entitlements: EntitlementPolicy
  readonly scheduleEvents: (at: number) => Promise<void>
  readonly pullTelegram: () => Promise<void>
  readonly routineEvent: EventHandler
  readonly mcpFetch: typeof fetch
  /** The agent's apps, made before Pi opened (their tools are Pi's). */
  readonly agentApps: AgentApps
  /** The run ledger and log lines the agent's services report to (ADR 0024). */
  readonly telemetry: RunTelemetry
}
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
  const topics = new TopicRegistry(db, {
    open: () => conversations.openConversation(),
    register: (chat, topic, name, now) => conversations.registerConversation(chat, topic, name, now),
    retitle: (chat, name) => conversations.retitle(chat, name),
  })
  const workspace = new WorkspaceFeed(harness, { conversations, apps, home, topics }, kit.chats)
  return { conversations, apps, home, topics, workspace }
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

/**
 * The agent's services over its SQLite, built once per isolate on first use: MCP host and grants, budget and models,
 * main's memory, conversations, resident authority, skills and the Telegram channel. Migrations run first, and every
 * server's endpoint binding is checked (a re-pointed server loses what it had).
 */
export async function composeServices(
  input: ComposeInput,
): Promise<ManagedRuntime.ManagedRuntime<AgentServices, never>> {
  const { env, harness } = input
  runApplicationMigrations(input.storage)
  const db = drizzle(input.storage)
  const { host, cipher, resident, eventStore, skillState, grants, approvals } = await makeHost(input, db)
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
  const fold = Number(env.MEMORY_FOLD_TOKENS ?? Number.NaN)
  const chats = new ChatDirectory(db)
  const memory = new MainMemory(db, harness, cheap('memory'), Number.isFinite(fold) ? { foldTokens: fold } : {}, chats)
  const { recall } = input.memory
  const capabilities = new CapabilityProfiles(db, input.subagentTools, retool(harness), chats)
  await restoreHelperExecution(db, harness, input.helperExtensions, chats)
  // Apply the current complete delegation tool set to retained Pi filters.
  await capabilities.retoolOnce('retool:subagent-config', nowSeconds())
  const routineServices = await makeRoutines(input)
  const kit = { thread: input.thread, recall, memory, namer: cheap('naming'), capabilities, chats }
  const conversations = conversationServices(db, input, kit)
  await memory.activate([input.memory.memory, recall])
  const skills = new SkillLibrary(host.manager, skillState, nowMillis)
  const learner = new SkillLearner({
    drafts: new SqliteDraftLog(db),
    harness,
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
  const events = await makeEvents(input, host, resident, eventStore, cipher)
  installEventConsumers(events, channel, skills, input.pullTelegram)
  return ManagedRuntime.make(
    Layer.mergeAll(
      agentLayer({
        host,
        approvals,
        chats,
        resident,
        ...conversations,
        budget,
        models,
        memory,
        skills,
        learner,
        channel,
        capabilities,
        ...routineServices,
      }),
      Layer.succeed(Entitlements, input.entitlements),
      Layer.succeed(Events, events),
      Layer.succeed(EventStorage, eventStore),
      Layer.succeed(Files, new FileStore(input.storage.sql, env.FILES, () => input.userId)),
      Layer.succeed(AppEngine, input.agentApps),
      Layer.succeed(Inspect, new Inspector(new RunLedger(db), conversations.conversations, harness)),
    ),
  )
}
