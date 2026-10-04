import { Agent } from 'agents'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { AppContext, JsonObject } from '@purrable/contracts'
import { PiHarness } from 'agents/harness/pi'
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
import { makePiHarness } from './pi/harness.ts'
import { MODEL_PROVIDER } from './pi/model.ts'
import { residentMcpExtension } from './pi/resident-mcp.ts'
import { ResidentAuthority } from './resident.ts'
import { ClientSessions } from './sessions.ts'
import { type TranscriptMessage, transcriptMessages } from './pi/transcript.ts'
import {
  type AgentServices,
  Budget,
  Mcp,
  Models,
  Resident,
  Sessions,
  agentLayer,
  attempt,
  attemptSync,
  nowSecondsEffect,
  requireBudget,
  requireResident,
} from './services.ts'
import { runApplicationMigrations } from './storage/migrations.ts'
import { ModelBudget, UsageStore, dailyTokenLimit } from './budget.ts'
import { ownerContent } from './pi/app-context.ts'
import { budgetExtension } from './pi/budget.ts'
import { ModelChoiceStore, ModelPicker, modelOptions } from './models.ts'

type Runtime = ManagedRuntime.ManagedRuntime<AgentServices, never>

const clientSession = (clientId: string, clientName: string | undefined, harness: PiHarness) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const now = yield* nowSecondsEffect
    return yield* attempt(() =>
      sessions.ensure(clientId, clientName, async () => (await harness.sessions.create()).id, now),
    )
  })

/** The model last applied to each session in this isolate, keyed by session id (`root` for the main thread). */
type Applied = Map<string, string>

/**
 * Puts a session on the user's model before a turn. Pi stores one model per conversation, set when it is created, so
 * a pick (or a new deployment default) reaches existing conversations only this way. Skipped when already applied.
 */
const useModel = (harness: PiHarness, applied: Applied, session: string | undefined) =>
  Effect.gen(function* () {
    const id = (yield* Models).current()
    const key = session ?? 'root'
    if (applied.get(key) === id) return
    yield* attempt(() => harness.session(session).setModel({ provider: MODEL_PROVIDER, id }))
    applied.set(key, id)
  })

/**
 * The resident agent. Pi (through the native PiHarness) owns conversations; the services in `services.ts` own MCP
 * connections, credentials, grants and resident authority. RPC methods are thin: they run one program each.
 */
export class PersonalAgent extends Agent<RuntimeEnv> implements AgentRpcMethods {
  readonly harness: PiHarness
  readonly #applied: Applied = new Map()
  #runtime: Promise<Runtime> | undefined

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env)
    const run = <A>(program: Effect.Effect<A, AppError, AgentServices>) => this.#runOrThrow(program)
    this.harness = makePiHarness(env, [residentMcpExtension(run), budgetExtension(run)])
    this.lifecycle.use(this.harness)
  }

  override async onStart(): Promise<void> {
    runApplicationMigrations(this.ctx.storage)
  }

  #services(): Promise<Runtime> {
    this.#runtime ??= (async () => {
      runApplicationMigrations(this.ctx.storage)
      const db = drizzle(this.ctx.storage)
      const host = new McpHost({
        servers: configuredServers(this.env.MCP_SERVERS),
        credentials: new CredentialStore(db, await CredentialCipher.fromBase64(this.env.CREDENTIAL_KEY)),
        grants: new GrantStore(db),
        appUrl: this.env.APP_URL,
        // SAFETY: the platform fetch is the outbound MCP/OAuth boundary; tokens are added only by the SDK transport.
        fetch: globalThis.fetch.bind(globalThis),
      })
      const budget = new ModelBudget(new UsageStore(db), dailyTokenLimit(this.env.MODEL_DAILY_TOKENS))
      const models = new ModelPicker(new ModelChoiceStore(db), modelOptions(this.env.MODELS, this.env.MODEL_ID))
      return ManagedRuntime.make(agentLayer(host, new ResidentAuthority(db), new ClientSessions(db), budget, models))
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

  /** The owner's message, with what an open App shared for the agent as separate untrusted blocks. */
  submit(input: string, operationId: string, appContext: readonly AppContext[] = []) {
    const harness = this.harness
    const model = useModel(harness, this.#applied, undefined)
    const content = ownerContent(input, appContext)
    return this.#owner(
      Effect.gen(function* () {
        yield* requireBudget
        yield* model
        return yield* attempt(() => harness.submit(content, { operationId }))
      }),
    )
  }

  modelChoice() {
    return this.#owner(Models.useSync((models) => models.choice()))
  }

  /** Stores the pick and moves the main thread to it at once; client sessions follow on their next turn. */
  chooseModel(modelId: string) {
    const model = useModel(this.harness, this.#applied, undefined)
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

  wait(operationId: string) {
    return this.#owner(attempt(() => this.harness.wait(operationId)))
  }

  stop(operationId?: string) {
    return this.#owner(
      attempt(() => (operationId === undefined ? this.harness.abort() : this.harness.abort({ operationId }))),
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
   * An inbound MCP client asks the resident agent something, in that client's own conversation. Needs current
   * resident authority (it does not renew it). Returns the answer, or `running` with the operation id to wait again.
   */
  askAsClient(clientId: string, clientName: string | undefined, input: string, operationId: string, waitMs: number) {
    const harness = this.harness
    const applied = this.#applied
    return this.#client(
      Effect.gen(function* () {
        yield* requireResident
        yield* requireBudget
        const session = yield* clientSession(clientId, clientName, harness)
        yield* useModel(harness, applied, session)
        yield* attempt(() => harness.submit(input, { session, operationId }))
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

  /** The client's own conversation, newest last. A client never sees the owner's main thread. */
  clientMessages(clientId: string, limit: number) {
    const harness = this.harness
    return this.#client(
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const session = sessions.find(clientId)
        if (session === undefined) return [] satisfies readonly TranscriptMessage[]
        return transcriptMessages(yield* attempt(() => harness.messages({ session })), limit)
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

  async messages(): Promise<readonly EntryRecord[]> {
    return this.harness.messages()
  }

  async sessionSnapshot(): Promise<JsonObject> {
    const stream = await this.harness.session().events()
    const snapshot = stream.snapshot
    await stream.stop()
    // SAFETY: Pi's snapshot is structured cloneable; JSON normalization narrows it to the shared RPC contract.
    return JSON.parse(JSON.stringify(snapshot)) as JsonObject
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/events') return piEventResponse(await this.harness.session().events())
    if (url.pathname === '/snapshot') return Response.json(await this.sessionSnapshot())
    return Response.json({ error: 'NotFound' }, { status: 404 })
  }
}
