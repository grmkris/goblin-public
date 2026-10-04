import { Agent } from 'agents'
import { type Extension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { type AppContext, type JsonObject, MAIN_THREAD } from '@purrable/contracts'
import { PiHarness } from 'agents/harness/pi'
import type { ProviderStreams } from '@earendil-works/pi-ai'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import type { AgentRpcMethods, RuntimeEnv } from './env.ts'
import { type AppError, toAppError } from './http/errors.ts'
import { type RpcResult, encodeExit } from './http/rpc.ts'
import { CredentialCipher } from './mcp/cipher.ts'
import { configuredServers } from './mcp/config.ts'
import { CredentialStore } from './mcp/credentials.ts'
import { GrantStore } from './mcp/grants.ts'
import { McpHost } from './mcp/host.ts'
import { piEventResponse } from './pi/events.ts'
import { type PiModels, makePiHarness } from './pi/harness.ts'
import { LITELLM_STREAMS, MODEL_PROVIDER, makePiModels } from './pi/model.ts'
import { personaExtension } from './pi/persona.ts'
import { subagentsExtension } from './pi/subagents.ts'
import { threadExtension } from './pi/thread.ts'
import { memoryExtensions } from './pi/memory.ts'
import { MainMemory } from './memory/memory.ts'
import { CheapModel } from './memory/model.ts'
import { residentMcpExtension } from './pi/resident-mcp.ts'
import { skillsExtension } from './pi/skills.ts'
import { SkillLibrary } from './skills/library.ts'
import { SqliteSkillState } from './skills/store.ts'
import { ResidentAuthority } from './resident.ts'
import { ConversationRegistry, type ThreadChange } from './conversations.ts'
import { BACKGROUND } from './pi/context.ts'
import { recentMessages } from './pi/transcript.ts'
import {
  type AgentServices,
  Budget,
  Conversations,
  Mcp,
  Memory,
  Models,
  Resident,
  agentLayer,
  attempt,
  attemptSync,
  nowSecondsEffect,
  requireBudget,
  requireResident,
} from './services.ts'
import { runApplicationMigrations } from './storage/migrations.ts'
import { nowMillis, nowSeconds } from './clock.ts'
import { bindEndpoints } from './mcp/endpoints.ts'
import { AddedServerStore, type ServerSource } from './mcp/servers.ts'
import { suggestions } from './mcp/suggested.ts'
import { RegistryStore } from './mcp/registries.ts'
import { logEndpointsReset } from './mcp/log.ts'
import { ModelBudget, UsageStore, dailyTokenLimit } from './budget.ts'
import { authoredContent, ownerContent } from './pi/content.ts'
import { budgetExtension } from './pi/budget.ts'
import { ModelChoiceStore, ModelPicker, memoryModelId, modelOptions } from './models.ts'

type Runtime = ManagedRuntime.ManagedRuntime<AgentServices, never>

/** The model last applied to each session in this isolate, keyed by session id. */
type Applied = Map<string, string>

/**
 * Puts a session on the user's model before a turn. Pi stores one model per conversation, set when it is created, so
 * a pick (or a new deployment default) reaches existing conversations only this way. Skipped when already applied.
 */
const useModel = (harness: PiHarness, applied: Applied, session: string) =>
  Effect.gen(function* () {
    const id = (yield* Models).current()
    if (applied.get(session) === id) return
    yield* attempt(() => harness.session(session).setModel({ provider: MODEL_PROVIDER, id }))
    applied.set(session, id)
  })

/** A registered conversation's Pi session, or `NotFound`: the gate every thread request passes. */
const registered = (thread: string) =>
  Conversations.use((conversations) => attemptSync(() => conversations.require(thread)))

/**
 * The resident agent. Pi (through the native PiHarness) owns conversations; the services in `services.ts` own MCP
 * connections, credentials, grants and resident authority. RPC methods are thin: they run one program each.
 */
export class PersonalAgent extends Agent<RuntimeEnv> implements AgentRpcMethods {
  readonly harness: PiHarness
  readonly #pi: PiModels
  readonly #thread: Extension
  readonly #memory: ReturnType<typeof memoryExtensions>
  readonly #applied: Applied = new Map()
  #runtime: Promise<Runtime> | undefined

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env)
    const run = <A>(program: Effect.Effect<A, AppError, AgentServices>) => this.#runOrThrow(program)
    this.#pi = makePiModels(env, this.modelStreams())
    const tools = [residentMcpExtension(run), budgetExtension(run)]
    // A subagent gets the persona and the owner's tools, nothing else: no subagents of its own, no ask_user.
    const subagents = subagentsExtension(run, [personaExtension, ...tools])
    this.#thread = threadExtension(run)
    this.#memory = memoryExtensions(run)
    const { memory, recall } = this.#memory
    // Skills are for main and threads; a subagent gets only the extensions its spawner hands it.
    this.harness = makePiHarness(this.#pi, [...tools, skillsExtension(run), subagents], [this.#thread, memory, recall])
    this.lifecycle.use(this.harness)
  }

  /** How model requests leave the object: LiteLLM. The integration harness overrides it with a scripted model. */
  protected modelStreams(): ProviderStreams {
    return LITELLM_STREAMS
  }

  override async onStart(): Promise<void> {
    runApplicationMigrations(this.ctx.storage)
  }

  #services(): Promise<Runtime> {
    this.#runtime ??= (async () => {
      runApplicationMigrations(this.ctx.storage)
      const db = drizzle(this.ctx.storage)
      const servers = configuredServers(this.env.MCP_SERVERS)
      const added = new AddedServerStore(db)
      const reset = bindEndpoints(db, [...servers, ...added.list()], nowSeconds())
      if (reset.length > 0) logEndpointsReset(reset)
      const skillState = new SqliteSkillState(db)
      const host = new McpHost({
        servers,
        added,
        registries: new RegistryStore(db),
        credentials: new CredentialStore(db, await CredentialCipher.fromBase64(this.env.CREDENTIAL_KEY)),
        grants: new GrantStore(db),
        skillsEnabled: (serverId) => skillState.enabled(serverId),
        appUrl: this.env.APP_URL,
        // SAFETY: the platform fetch is the outbound MCP/OAuth boundary; tokens are added only by the SDK transport.
        fetch: globalThis.fetch.bind(globalThis),
      })
      const budget = new ModelBudget(new UsageStore(db), dailyTokenLimit(this.env.MODEL_DAILY_TOKENS))
      const options = modelOptions(this.env.MODELS, this.env.MODEL_ID)
      const models = new ModelPicker(new ModelChoiceStore(db), options)
      const namer = new CheapModel(this.#pi.models, memoryModelId(this.env.MEMORY_MODEL, options), (tokens) =>
        budget.record(tokens, nowSeconds()),
      )
      const memory = new MainMemory(db, this.harness, namer)
      const { recall } = this.#memory
      await memory.activate([this.#memory.memory, recall])
      const kit = { thread: this.#thread, recall, memory, namer }
      const conversations = new ConversationRegistry(db, this.harness, kit, nowSeconds())
      const resident = new ResidentAuthority(db)
      const skills = new SkillLibrary(host.manager, skillState, nowMillis)
      return ManagedRuntime.make(agentLayer({ host, resident, conversations, budget, models, memory, skills }))
    })()
    this.#runtime.catch(() => {
      this.#runtime = undefined
    })
    return this.#runtime
  }

  async #exit<A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<Exit.Exit<A, AppError>> {
    try {
      return await (await this.#services()).runPromiseExit(program)
    } catch (cause) {
      return Exit.fail(toAppError(cause))
    }
  }

  async #runOrThrow<A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<A> {
    const exit = await this.#exit(program)
    if (Exit.isSuccess(exit)) return exit.value
    const result = encodeExit(exit)
    throw result.ok ? toAppError(undefined) : toAppError(result.error)
  }

  /** An owner request: renew resident authority, then run the program. */
  async #owner<A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<RpcResult<A>> {
    const renewed = Effect.gen(function* () {
      const resident = yield* Resident
      const now = yield* nowSecondsEffect
      resident.renew(now)
      return yield* program
    })
    return encodeExit(await this.#exit(renewed))
  }

  /** The owner's message into a thread, with what an open App shared for the agent as separate untrusted blocks. */
  submit(thread: string, input: string, operationId: string, appContext: readonly AppContext[] = []) {
    const harness = this.harness
    const applied = this.#applied
    const content = ownerContent(input, appContext)
    return this.#owner(
      Effect.gen(function* () {
        yield* requireBudget
        const session = yield* registered(thread)
        yield* useModel(harness, applied, session)
        return yield* attempt(() => harness.submit(content, { session, operationId }))
      }),
    )
  }

  threads() {
    return this.#owner(Conversations.use((conversations) => attempt(() => conversations.list())))
  }

  /** A thread branched from main at one of its messages (`from`, a Pi entry id), or an empty one. */
  createThread(from?: number) {
    return this.#owner(
      Effect.gen(function* () {
        const conversations = yield* Conversations
        const now = yield* nowSecondsEffect
        return yield* attempt(() => (from === undefined ? conversations.create(now) : conversations.branch(from, now)))
      }),
    )
  }

  updateThread(thread: string, change: ThreadChange) {
    return this.#owner(
      Effect.gen(function* () {
        const conversations = yield* Conversations
        const now = yield* nowSecondsEffect
        return yield* attempt(() => conversations.update(thread, change, now))
      }),
    )
  }

  modelChoice() {
    return this.#owner(Models.useSync((models) => models.choice()))
  }

  /** Stores the pick and moves main to it at once; other threads follow on their next turn. */
  chooseModel(modelId: string) {
    const model = useModel(this.harness, this.#applied, MAIN_THREAD)
    return this.#owner(
      Effect.gen(function* () {
        const models = yield* Models
        const now = yield* nowSecondsEffect
        const choice = yield* attemptSync(() => models.choose(modelId, now))
        yield* model
        return choice
      }),
    )
  }

  usageToday() {
    return this.#owner(
      Effect.gen(function* () {
        const budget = yield* Budget
        return budget.today(yield* nowSecondsEffect)
      }),
    )
  }

  memoryStatus() {
    return this.#owner(
      Memory.use((memory) => Effect.succeed({ messages: memory.size(), summarized: memory.viewThrough() })),
    )
  }

  stop(thread: string, operationId?: string) {
    const harness = this.harness
    return this.#owner(
      Effect.gen(function* () {
        const session = yield* registered(thread)
        return yield* attempt(() => harness.abort({ session, ...(operationId === undefined ? {} : { operationId }) }))
      }),
    )
  }

  mcpServers() {
    return this.#owner(Mcp.useSync((mcp) => mcp.servers()))
  }

  mcpConnect(serverId: string) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.beginConnect(serverId))))
  }

  mcpFinishConnect(state: string, code: string, issuer?: string) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.finishConnect(state, code, issuer))))
  }

  mcpSuggested() {
    const stage = this.env.STAGE
    return this.#owner(
      Mcp.useSync((mcp) => suggestions(stage, new Set(mcp.manager.servers.map((server) => server.endpoint)))),
    )
  }

  mcpCatalog(query: string) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.searchCatalog(query))))
  }

  mcpRegistries() {
    return this.#owner(Mcp.useSync((mcp) => mcp.registries()))
  }

  mcpAddRegistry(url: string) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.addRegistry(url))))
  }

  mcpRemoveRegistry(url: string) {
    return this.#owner(Mcp.use((mcp) => attemptSync(() => mcp.removeRegistry(url))))
  }

  mcpAddServer(endpoint: string, source?: ServerSource) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.addServer(endpoint, source))))
  }

  mcpRemoveServer(serverId: string) {
    return this.#owner(Mcp.use((mcp) => attempt(async () => (await mcp.removeServer(serverId), null))))
  }

  mcpDisconnect(serverId: string) {
    return this.#owner(Mcp.use((mcp) => attempt(async () => (await mcp.disconnect(serverId), null))))
  }

  mcpTools(serverId: string, refresh: boolean) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.tools(serverId, refresh))))
  }

  mcpGrants() {
    return this.#owner(Mcp.useSync((mcp) => mcp.grants()))
  }

  mcpSetToolGrant(serverId: string, name: string, allowed: boolean) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.setToolGrant(serverId, name, allowed))))
  }

  mcpSetAppGrant(serverId: string, uri: string, allowed: boolean) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.setAppGrant(serverId, uri, allowed))))
  }

  mcpCallTool(serverId: string, name: string, args: Record<string, unknown>, caller: 'human' | 'app') {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.manager.callTool(serverId, name, args, { caller }))))
  }

  mcpReadResource(serverId: string, uri: string, caller: 'human' | 'app') {
    return this.#owner(
      Mcp.use((mcp) =>
        attempt(() =>
          caller === 'app' ? mcp.manager.readAppResource(serverId, uri) : mcp.manager.readResource(serverId, uri),
        ),
      ),
    )
  }

  mcpGetPrompt(serverId: string, name: string, args: Record<string, string>) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.manager.getPrompt(serverId, name, args))))
  }

  residentStatus() {
    return this.#owner(
      Effect.gen(function* () {
        const resident = yield* Resident
        return resident.status(yield* nowSecondsEffect)
      }),
    )
  }

  /** Revoke or re-enable resident authority. Not an ordinary owner request: revoking must not renew first. */
  async residentSet(enabled: boolean) {
    return encodeExit(
      await this.#exit(
        Effect.gen(function* () {
          const resident = yield* Resident
          const now = yield* nowSecondsEffect
          if (enabled) resident.enable(now)
          else resident.revoke(now)
          return resident.status(now)
        }),
      ),
    )
  }

  /**
   * An inbound MCP client asks the resident agent something, in main and labelled with the client's name, so the
   * owner sees it and the agent answers with everything main knows. Needs current resident authority (it does not
   * renew it). Returns the answer, or `running` with the operation id to wait again.
   */
  askAsClient(author: string, input: string, operationId: string, waitMs: number) {
    const harness = this.harness
    const applied = this.#applied
    const session = MAIN_THREAD
    return this.#client(
      Effect.gen(function* () {
        yield* requireResident
        yield* requireBudget
        yield* useModel(harness, applied, session)
        yield* attempt(() => harness.submit(authoredContent(author, input), { session, operationId }))
        const result = yield* attempt(() =>
          harness.wait(operationId, { session, signal: AbortSignal.timeout(waitMs) }).catch(() => undefined),
        )
        if (result === undefined) return { status: 'running' as const, operationId }
        return result.status === 'done'
          ? { status: 'done' as const, operationId, text: result.text ?? '' }
          : { status: 'unanswered' as const, operationId, reason: result.reason ?? 'unanswered' }
      }),
    )
  }

  /** Main's latest messages, newest last, for an inbound client (`get_recent_messages`). */
  recentMessages(limit: number) {
    const harness = this.harness
    return this.#client(
      attempt(async () => {
        const main = await (await harness.pi()).conversation(ROOT_CONVERSATION_ID, BACKGROUND)
        return main === undefined ? [] : recentMessages(main, limit)
      }),
    )
  }

  /**
   * Account deletion: close outbound connections, then erase this agent (every Pi, Agents and application table,
   * the alarm) through `Agent.destroy()`, which also aborts the isolate so no in-memory state survives. Callers may
   * see that abort instead of the result (`auth/account.ts`).
   */
  async deleteAgentData(): Promise<RpcResult<true>> {
    const runtime = this.#runtime
    this.#runtime = undefined
    if (runtime !== undefined) {
      const services = await runtime.catch(() => undefined)
      await services?.runPromise(Mcp.use((mcp) => attempt(() => mcp.manager.closeAll()))).catch(() => undefined)
      await services?.dispose()
    }
    await this.destroy()
    return { ok: true, value: true }
  }

  /** An inbound client request: no resident renewal (only the owner renews). */
  async #client<A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<RpcResult<A>> {
    return encodeExit(await this.#exit(program))
  }

  async sessionSnapshot(session: string): Promise<JsonObject> {
    const stream = await this.harness.session(session).events()
    const snapshot = stream.snapshot
    await stream.stop()
    // SAFETY: Pi's snapshot is structured cloneable; JSON normalization narrows it to the shared RPC contract.
    return JSON.parse(JSON.stringify(snapshot)) as JsonObject
  }

  /**
   * `/threads/<id>/events` (SSE), `/threads/<id>/snapshot` and `/threads/<id>/history?before=<entry>`, for registered
   * conversations only.
   */
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const [, thread = '', view = ''] = /^\/threads\/(\d{1,12})\/(events|snapshot|history)$/u.exec(url.pathname) ?? []
    const session = await this.#exit(registered(thread))
    if (view === '' || Exit.isFailure(session)) return Response.json({ error: 'NotFound' }, { status: 404 })
    if (view === 'events') return piEventResponse(await this.harness.session(session.value).events())
    if (view === 'snapshot') return Response.json(await this.sessionSnapshot(session.value))
    const before = Number(url.searchParams.get('before'))
    if (!Number.isSafeInteger(before) || before < 1) return Response.json({ error: 'InvalidInput' }, { status: 400 })
    const page = await this.#exit(
      Conversations.use((conversations) => attempt(() => conversations.history(session.value, before))),
    )
    return Exit.isSuccess(page) ? Response.json(page.value) : Response.json({ error: 'NotFound' }, { status: 404 })
  }
}
