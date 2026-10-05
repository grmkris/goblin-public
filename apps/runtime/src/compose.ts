import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Entitlements, type EntitlementPolicy } from './billing/gates.ts'
import { ModelBudget, UsageStore, modelTokenWeights } from './budget.ts'
import { CapabilityProfiles, type PiTools } from './capabilities/profiles.ts'
import { TelegramChannel } from './channel/channel.ts'
import { nowMillis, nowSeconds } from './clock.ts'
import { ConversationRegistry } from './conversations.ts'
import type { RuntimeEnv } from './env.ts'
import { CredentialCipher } from './mcp/cipher.ts'
import { configuredServers } from './mcp/config.ts'
import { CredentialStore } from './mcp/credentials.ts'
import { bindEndpoints } from './mcp/endpoints.ts'
import { GrantStore } from './mcp/grants.ts'
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

/** What the agent's services are built from: its storage and env, and the Pi pieces its constructor made. */
export type ComposeInput = {
  readonly storage: DurableObjectStorage
  readonly env: RuntimeEnv
  readonly harness: PiHarness
  readonly pi: PiModels
  readonly thread: Extension
  readonly memory: ReturnType<typeof memoryExtensions>
  /** The `subagent` tool, which Pi's tool filter removes where subagents are switched off. */
  readonly subagentTool: ToolRegistration
  /** Schedules the Telegram replies alarm. */
  readonly scheduleReplies: () => void
  readonly entitlements: EntitlementPolicy
}

/** Sets a conversation's Pi tool filter (where subagents are switched off), leaving its extensions as they are. */
const retool = (harness: PiHarness) => async (session: string, tools: PiTools) => {
  const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
  await conversation?.configure({ tools }, BACKGROUND)
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
  const servers = configuredServers(env.MCP_SERVERS)
  const added = new AddedServerStore(db)
  const reset = bindEndpoints(db, [...servers, ...added.list()], nowSeconds())
  if (reset.length > 0) logEndpointsReset(reset)
  const skillState = new SqliteSkillState(db)
  const grants = new GrantStore(db)
  const cipher = await CredentialCipher.fromBase64(env.CREDENTIAL_KEY)
  const host = new McpHost({
    servers,
    added,
    registries: new RegistryStore(db),
    credentials: new CredentialStore(db, cipher),
    grants,
    skillsEnabled: (serverId) => skillState.enabled(serverId),
    appUrl: env.APP_URL,
    // SAFETY: the platform fetch is the outbound MCP/OAuth boundary; tokens are added only by the SDK transport.
    fetch: globalThis.fetch.bind(globalThis),
  })
  const budget = new ModelBudget(
    new UsageStore(db),
    async () => (await Effect.runPromise(input.entitlements.require())).dailyTokens,
    modelTokenWeights(env.MODEL_TOKEN_WEIGHTS),
  )
  const options = modelOptions(env.MODELS, env.MODEL_ID)
  const models = new ModelPicker(new ModelChoiceStore(db), options)
  const cheapModelId = memoryModelId(env.MEMORY_MODEL, options)
  const namer = new CheapModel(input.pi.models, cheapModelId, (tokens) =>
    budget.record(tokens, nowSeconds(), cheapModelId),
  )
  const memory = new MainMemory(db, harness, namer)
  const { recall } = input.memory
  await memory.activate([input.memory.memory, recall])
  const capabilities = new CapabilityProfiles(db, input.subagentTool, retool(harness))
  const kit = { thread: input.thread, recall, memory, namer, capabilities }
  const conversations = new ConversationRegistry(db, harness, kit, nowSeconds())
  const resident = new ResidentAuthority(db)
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
  return ManagedRuntime.make(
    Layer.mergeAll(
      agentLayer({ host, resident, conversations, budget, models, memory, skills, learner, channel, capabilities }),
      Layer.succeed(Entitlements, input.entitlements),
    ),
  )
}
