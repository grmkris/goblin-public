import { Agent } from 'agents'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { JsonObject } from '@purrable/contracts'
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
import { residentMcpExtension } from './pi/resident-mcp.ts'
import { ResidentAuthority } from './resident.ts'
import { type AgentServices, Mcp, Resident, agentLayer, attempt, nowSecondsEffect } from './services.ts'
import { runApplicationMigrations } from './storage/migrations.ts'

type Runtime = ManagedRuntime.ManagedRuntime<AgentServices, never>

/**
 * The resident agent. Pi (through the native PiHarness) owns conversations; the services in `services.ts` own MCP
 * connections, credentials, grants and resident authority. RPC methods are thin: they run one program each.
 */
export class PersonalAgent extends Agent<RuntimeEnv> implements AgentRpcMethods {
  readonly harness: PiHarness
  #runtime: Promise<Runtime> | undefined

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env)
    this.harness = makePiHarness(env, [residentMcpExtension((program) => this.#runOrThrow(program))])
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
      return ManagedRuntime.make(agentLayer(host, new ResidentAuthority(db)))
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

  submit(input: string, operationId: string) {
    return this.#owner(attempt(() => this.harness.submit(input, { operationId })))
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
