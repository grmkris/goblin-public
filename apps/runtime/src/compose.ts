import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { ModelBudget, UsageStore, modelTokenWeights } from './budget.ts'
import { CapabilityProfiles, type PiTools } from './capabilities/profiles.ts'
import { TelegramChannel } from './channel/channel.ts'
import { nowMillis, nowSeconds } from './clock.ts'
import { ConversationRegistry, type ThreadKit } from './conversations.ts'
import { WorkspaceFeed } from './workspace/feed.ts'
import { AppRegistry } from './apps/registry.ts'
import type { RuntimeEnv } from './env.ts'
import { CredentialCipher } from './mcp/cipher.ts'
import { configuredServers } from './mcp/config.ts'
import { CredentialStore } from './mcp/credentials.ts'
import { bindEndpoints } from './mcp/endpoints.ts'
import { GrantStore } from './mcp/grants.ts'
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
import { ModelChoiceStore, ModelPicker, memoryModelId, modelOptions } from './models.ts'
import { BACKGROUND, conversationId } from './pi/context.ts'
import type { PiModels } from './pi/harness.ts'
import type { memoryExtensions } from './pi/memory.ts'
import { ResidentAuthority } from './resident.ts'
import { type AgentServices, agentLayer } from './services.ts'
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
import { MemberAccess } from './members/access.ts'
import { MemberController } from './members/controller.ts'
import { MemberUsage } from './members/usage.ts'

/** What the agent's services are built from: its storage and env, and the Pi pieces its constructor made. */
export type ComposeInput = {
  readonly storage: DurableObjectStorage
  readonly env: RuntimeEnv
  readonly harness: PiHarness
  readonly pi: PiModels
  readonly thread: Extension
  readonly memory: ReturnType<typeof memoryExtensions>
  /** The `subagent` tool, which Pi's tool filter removes where subagents are switched off. */
  readonly memberExtensions: readonly Extension[]
  readonly subagentTool: ToolRegistration
  /** Schedules the Telegram replies alarm. */
  readonly scheduleReplies: () => void
  readonly userId: string
  readonly entitlements: EntitlementPolicy
  readonly scheduleEvents: (at: number) => Promise<void>
  readonly pullTelegram: () => Promise<void>
  readonly routineEvent: EventHandler
  readonly mcpFetch: typeof fetch
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
  const routineUsage = new RoutineUsage(
    db,
    routineRuns,
    modelTokenWeights(input.env.MODEL_TOKEN_WEIGHTS),
    input.harness,
  )
  await installRoutineUsage(input.harness, routineUsage, routineRuns)
  return { routines, routineRuns, routineUsage }
}
/** The conversation registry, the kept Apps (closed with their conversation), and the live workspace feed over both. */
function conversationServices(db: DrizzleSqliteDODatabase, harness: PiHarness, kit: ThreadKit) {
  const conversations = new ConversationRegistry(db, harness, kit, nowSeconds())
  const apps = new AppRegistry(db, harness)
  conversations.onChange((ids) => apps.closeWithConversations(ids, nowSeconds()))
  return { conversations, apps, workspace: new WorkspaceFeed(harness, conversations, apps) }
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
    skillsEnabled: (serverId) => skillState.enabled(serverId),
    appUrl: env.APP_URL,
    fetch: input.mcpFetch,
  })
  return { host, cipher, resident, eventStore, skillState, grants }
}
function makeBudgets(input: ComposeInput, db: DrizzleSqliteDODatabase) {
  const env = input.env
  const memberBudgets = new MemberUsage(env, input.userId, modelTokenWeights(env.MODEL_TOKEN_WEIGHTS))
  const budget = new ModelBudget(
    new UsageStore(db),
    async () => (await Effect.runPromise(input.entitlements.require())).dailyTokens,
    modelTokenWeights(env.MODEL_TOKEN_WEIGHTS),
    (day) => memberBudgets.tokens(input.userId, day),
  )
  return { memberBudgets, budget }
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
  const { host, cipher, resident, eventStore, skillState, grants } = await makeHost(input, db)
  const { memberBudgets, budget } = makeBudgets(input, db)
  const options = modelOptions(env.MODELS, env.MODEL_ID)
  const models = new ModelPicker(new ModelChoiceStore(db), options)
  const cheapModelId = memoryModelId(env.MEMORY_MODEL, options)
  const namer = new CheapModel(input.pi.models, cheapModelId, (tokens) =>
    budget.record(tokens, nowSeconds(), cheapModelId),
  )
  const memory = new MainMemory(db, harness, namer)
  const { recall } = input.memory
  await memory.activate([input.memory.memory, recall])
  const memberAccess = new MemberAccess(db, env, input.userId)
  const capabilities = new CapabilityProfiles(db, input.subagentTool, retool(harness), (session) =>
    memberAccess.bound(session),
  )
  const routineServices = await makeRoutines(input)
  const kit = { thread: input.thread, recall, memory, namer, capabilities }
  const conversations = conversationServices(db, harness, kit)
  const members = new MemberController({
    db,
    env,
    owner: input.userId,
    access: memberAccess,
    kit: {
      harness,
      registry: conversations.conversations,
      capabilities,
      extensions: input.memberExtensions,
      modelId: () => models.current(),
      host,
      resident,
    },
    cipher,
    usage: memberBudgets,
  })
  await members.install()
  const skills = new SkillLibrary(host.manager, skillState, nowMillis)
  const learner = new SkillLearner({
    drafts: new SqliteDraftLog(db),
    harness,
    manager: host.manager,
    library: skills,
    state: skillState,
    model: namer,
    allows: (serverId, name) => grants.allows({ serverId, capability: 'tool', name }),
    now: nowMillis,
  })
  const channel = new TelegramChannel(db, cipher, input.scheduleReplies)
  const events = await makeEvents(input, host, resident, eventStore, cipher)
  installEventConsumers(events, channel, skills, input.pullTelegram)
  return ManagedRuntime.make(
    Layer.mergeAll(
      agentLayer({
        host,
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
        members,
      }),
      Layer.succeed(Entitlements, input.entitlements),
      Layer.succeed(Events, events),
      Layer.succeed(EventStorage, eventStore),
    ),
  )
}
