import { Agent } from 'agents'
import { type Extension } from '@earendil-works/pi-durable'
import { type AppContext, type CapabilityChange, type JsonObject, MAIN_THREAD } from '@goblin/contracts'
import type { AgentAppChange, AppCall, AppDiagnostic, CreateApp, DeleteAgentApp, UpdateApp } from '@goblin/contracts'
import { PiHarness } from 'agents/harness/pi'
import type { ProviderStreams } from '@earendil-works/pi-ai'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import type { AgentRpcMethods, RuntimeEnv } from './env.ts'
import { type AppError, Forbidden, toAppError } from './http/errors.ts'
import { type ChannelPorts, TelegramChannel, channelCall, logChannelFailure } from './channel/channel.ts'
import { channelPorts } from './channel/turns.ts'
import { type Doorbell, doorbellValid } from './channel/doorbell.ts'
import { type RpcResult, encodeExit, unwrap } from './http/rpc.ts'
import { FileStore } from './files/store.ts'
import { filesExtension } from './pi/files.ts'
import { type AgentApps, agentApps } from './agent-apps/engine.ts'
import { JOB_CALLBACK, type JobSchedules, type JobSlot, logAppJobs } from './agent-apps/jobs.ts'
import { appsExtension } from './pi/apps.ts'
import { serversExtension } from './pi/servers.ts'
import { agentRequest, sessionSnapshot } from './agent-requests.ts'
import { type PiModels, makePiHarness } from './pi/harness.ts'
import { type AgentTelemetry, agentTelemetry } from './telemetry/agent.ts'
import { LITELLM_STREAMS, makePiModels } from './pi/model.ts'
import { personaExtension } from './pi/persona.ts'
import { type SubagentKit, subagentsExtension } from './pi/subagents.ts'
import { threadExtension } from './pi/thread.ts'
import { memoryExtensions } from './pi/memory.ts'
import { residentMcpExtension } from './pi/resident-mcp.ts'
import { skillsExtension } from './pi/skills.ts'
import { composeServices } from './compose.ts'
import { capabilitiesOf, changeCapabilities } from './capabilities/program.ts'
import {
  type AgentServices,
  Channel,
  Conversations,
  Mcp,
  Memory,
  Models,
  Resident,
  attempt,
  attemptSync,
  nowSecondsEffect,
  requireResident,
  Routines,
  RoutineRuns,
} from './services.ts'
import { accountEntitlements, Entitlements, type EntitlementPolicy } from './billing/gates.ts'
import { runApplicationMigrations } from './storage/migrations.ts'
import { nowMillis, nowSeconds } from './clock.ts'
import type { ServerSource } from './mcp/servers.ts'
import { Events, type EventWebhook } from './mcp/events.ts'
import { enableTelegram, disableTelegram } from './channel/program.ts'
import { setSkillEvents } from './skills/events.ts'
import { disconnectOwnerServer, ownerServers, removeOwnerServer, suggestedServers } from './mcp/program.ts'
import {
  askClient,
  createOwnerConversation,
  markOwnerRead,
  ownerRequest,
  recentOwnerMessages,
  ownerUsage,
  setResident,
  submitOwner,
  stopOwner,
  updateOwnerConversation,
} from './agent-program.ts'
import * as AppPrograms from './apps/program.ts'
import { budgetExtension } from './pi/budget.ts'
import { chooseOwnerModel, useModel, type Applied } from './agent-model.ts'
import { routinesExtension } from './pi/routines.ts'
import { editRoutine, proposeRoutine, routinesList, setRoutineSettings } from './routines/program.ts'
import type {
  CreateConversation,
  RoutineEdit,
  RoutineProposal,
  RoutineRevision,
  RoutineSettings,
  RoutineManualRun,
  UpdateConversation,
} from '@goblin/contracts'
import { requireRoutine, requireRoutineSession } from './routines/authority.ts'
import { runView } from './routines/runs.ts'
import type { RoutineSlot } from './routines/scheduler.ts'
import {
  RoutineController,
  routineExtensions,
  routineSchedulePorts,
  routineChangeProgram,
} from './routines/controller.ts'

type Runtime = ManagedRuntime.ManagedRuntime<AgentServices, never>

/**
 * The resident agent. Pi (through the native PiHarness) owns conversations; the services in `services.ts` own MCP
 * connections, credentials, grants and resident authority. RPC methods are thin: they run one program each.
 */
export class PersonalAgent extends Agent<RuntimeEnv> implements AgentRpcMethods {
  readonly harness: PiHarness
  readonly #pi: PiModels
  readonly #thread: Extension
  readonly #memory: ReturnType<typeof memoryExtensions>
  readonly #subagents: SubagentKit
  readonly #applied: Applied = new Map()
  readonly #routines: RoutineController
  readonly #apps: AgentApps
  readonly #telemetry: AgentTelemetry
  #runtime: Promise<Runtime> | undefined
  /** The Telegram pull in progress: one at a time (channelPull). */
  #pulling: Promise<void> = Promise.resolve()
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env)
    const run = <A>(program: Effect.Effect<A, AppError, AgentServices>) => this.#runOrThrow(program)
    const routineRun = <A>(program: Effect.Effect<A, AppError, AgentServices>) => this.#runOrThrow(program, false)
    this.#pi = makePiModels(env, this.modelStreams(), undefined, (id) => routineRun(requireRoutine(id)))
    const residentTools = residentMcpExtension(run, (session) => routineRun(requireRoutineSession(session)))
    const tools = [residentTools, budgetExtension(run)]
    // A subagent gets the persona, the owner's tools and subagents of its own, nothing else: no ask_user.
    this.#subagents = subagentsExtension(run, (self) => [personaExtension, ...tools, self])
    const subagents = this.#subagents.extension
    this.#thread = threadExtension(run)
    this.#memory = memoryExtensions(run)
    const { memory, recall } = this.#memory
    const routineKit = routineExtensions(routineRun, residentTools, env.CREDENTIAL_KEY)
    // Skills and apps are for main and threads; a subagent gets only the extensions its spawner hands it.
    const apps = agentApps(ctx.storage, env, () => this.name, { schedules: this.#jobSchedules() })
    this.#apps = apps
    this.#telemetry = agentTelemetry(ctx.storage, () => this.name, run)
    const base = [...tools, skillsExtension(run), filesExtension(run), appsExtension(apps)]
    const own = [serversExtension(run, env.STAGE), subagents, routinesExtension(run), this.#telemetry.diagnose]
    const extras = [this.#thread, memory, recall, ...routineKit.extra]
    this.harness = makePiHarness(this.#pi, [...base, ...own], extras, apps, this.#telemetry.recorder)
    this.#routines = new RoutineController(routineRun, this.harness, routineKit.start, {
      storage: this.ctx.storage,
      owner: () => this.name,
      key: env.CREDENTIAL_KEY,
      schedules: routineSchedulePorts({
        list: () => this.listSchedules(),
        cancel: (id) => this.cancelSchedule(id),
        armNative: (at, payload) => this.schedule(at, 'runRoutine', payload, { idempotent: true }),
        deadlineNative: (at, payload) => this.schedule(at, 'runRoutineDeadline', payload, { idempotent: true }),
        wake: (at) => this.#scheduleWake('routinesWake', at),
      }),
    })
    this.lifecycle.use(this.harness)
  }
  /** The native schedules that run the agent's apps' jobs (ADR 0021). */
  #jobSchedules(): JobSchedules {
    return {
      list: () => this.listSchedules(),
      arm: async (at, slot) => (await this.schedule(new Date(at), JOB_CALLBACK, slot, { idempotent: true })).id,
      cancel: (id) => this.cancelSchedule(id),
    }
  }
  /** How model requests leave the object: LiteLLM. The integration harness overrides it with a scripted model. */
  protected modelStreams(): ProviderStreams {
    return LITELLM_STREAMS
  }
  /** The normal platform boundary; tests inject an official SDK fixture without changing authorization. */
  protected mcpFetch(): typeof fetch {
    // SAFETY: SDK transport alone adds OAuth tokens; binding platform fetch preserves its execution context.
    return globalThis.fetch.bind(globalThis)
  }
  override async onStart(): Promise<void> {
    runApplicationMigrations(this.ctx.storage)
    this.#telemetry.restarted(Date.now())
    // Reconstruct lease and receipt recovery without opening Pi or waiting on outbound network calls.
    await this.#scheduleWake('mcpEventsWake', Date.now() + 1000)
    await this.#scheduleWake('routinesWake', Date.now() + 1000)
    await this.#apps.jobs.reconcile().catch((error: unknown) => logAppJobs(error))
  }

  /** Tests inject account authority here; the deployed object always reads its own account in auth D1. */
  protected entitlementPolicy(): EntitlementPolicy {
    return accountEntitlements(this.env, () => this.name)
  }
  #services(): Promise<Runtime> {
    this.#runtime ??= composeServices({
      storage: this.ctx.storage,
      env: this.env,
      harness: this.harness,
      pi: this.#pi,
      thread: this.#thread,
      memory: this.#memory,
      subagentTool: this.#subagents.tool,
      scheduleReplies: () => void this.schedule(5, 'channelReplies'),
      userId: this.name,
      entitlements: this.entitlementPolicy(),
      scheduleEvents: (at) => this.#scheduleWake('mcpEventsWake', at),
      pullTelegram: () => this.channelPull(),
      routineEvent: (context) => this.#routines.consumeEvent(context),
      mcpFetch: this.mcpFetch(),
      agentApps: this.#apps,
      telemetry: this.#telemetry.telemetry,
    })
    this.#runtime.catch(() => {
      this.#runtime = undefined
    })
    return this.#runtime
  }
  /** One earliest Events wake. Agent schedules are durable and reconstructed independently of Pi. */
  async #scheduleWake(callback: 'mcpEventsWake' | 'routinesWake', at: number): Promise<void> {
    // listSchedules includes the currently executing wake; only future jobs can replace the next sweep.
    const now = nowSeconds()
    const pending = (await this.listSchedules()).filter((job) => job.callback === callback && job.time > now)
    const seconds = Math.ceil(at / 1000)
    if (pending.some((job) => job.time <= seconds)) return
    // Dated schedule dedupe ignores the date; include the instant so advancing a wake cannot cancel its replacement.
    await this.schedule(new Date(seconds * 1000), callback, { at: seconds }, { idempotent: true })
    for (const job of pending) await this.cancelSchedule(job.id)
  }
  mcpEventsWebhook(input: EventWebhook) {
    return this.#client(Events.use((events) => events.receive(input)))
  }
  async mcpEventsWake(): Promise<void> {
    await this.#runOrThrow(Events.use((events) => events.maintain())).catch(() =>
      this.#scheduleWake('mcpEventsWake', Date.now() + 60_000),
    )
  }
  async routinesWake(): Promise<void> {
    await this.#routines.maintain().catch(() => this.#scheduleWake('routinesWake', Date.now() + 60_000))
  }
  async runRoutine(slot: RoutineSlot): Promise<void> {
    await this.#routines.fire(slot)
  }
  async runRoutineDeadline(input: { runId: string }): Promise<void> {
    await this.#routines.deadline(input.runId)
  }
  /** An agent app's job is due (ADR 0021). */
  async runAppJob(slot: JobSlot): Promise<void> {
    await this.#apps.jobs.fire(slot)
  }

  async #exit<A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<Exit.Exit<A, AppError>> {
    try {
      return await (await this.#services()).runPromiseExit(program)
    } catch (cause) {
      return Exit.fail(toAppError(cause))
    }
  }

  async #runOrThrow<A>(program: Effect.Effect<A, AppError, AgentServices>, checkPlan = true): Promise<A> {
    const exit = await this.#exit(
      Effect.andThen(checkPlan ? Entitlements.use((plans) => plans.require()) : Effect.void, program),
    )
    if (Exit.isSuccess(exit)) return exit.value
    return unwrap(encodeExit(exit))
  }

  /** An owner request: renew resident authority, then run the program. */
  async #owner<A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<RpcResult<A>> {
    return encodeExit(await this.#exit(ownerRequest(program)))
  }
  /** The owner's message into a thread, with what an open App shared for the agent as separate untrusted blocks. */
  submit(
    thread: string,
    input: string,
    operationId: string,
    appContext: readonly AppContext[] = [],
    attachments: readonly string[] = [],
  ) {
    const runtime = {
      harness: this.harness,
      applied: this.#applied,
      routines: this.#routines,
      subagents: this.#subagents,
    }
    return this.#owner(submitOwner({ ...runtime, thread, text: input, operationId, appContext, attachments }))
  }
  conversations() {
    return this.#owner(Conversations.use((conversations) => attempt(() => conversations.list())))
  }
  routines() {
    return this.#owner(routinesList)
  }
  routinePropose(input: RoutineProposal) {
    return this.#owner(proposeRoutine(input.definition, input.operationId))
  }
  routineEdit(id: string, input: RoutineEdit) {
    return this.#owner(Effect.tap(editRoutine(id, input), () => attempt(() => this.#routines.reconcile())))
  }
  routineChange(id: string, input: RoutineRevision, action: 'confirm' | 'pause' | 'archive') {
    return this.#owner(routineChangeProgram(this.#routines, id, input, action))
  }
  routineRun(id: string, input: RoutineManualRun) {
    return this.#owner(attempt(async () => runView(await this.#routines.manual(id, input))))
  }
  routineRuns(id: string) {
    return this.#owner(RoutineRuns.use((store) => attemptSync(() => ({ runs: store.list(id) }))))
  }
  routineSettings() {
    return this.#owner(Routines.useSync((store) => store.settings()))
  }
  routineSettingsSet(settings: RoutineSettings) {
    return this.#owner(setRoutineSettings(settings))
  }

  /** A thread branched from a message of any open conversation, or an empty one. */
  createConversation(input: CreateConversation) {
    return this.#owner(createOwnerConversation(input))
  }
  updateConversation(id: string, change: UpdateConversation) {
    return this.#owner(updateOwnerConversation(this.#routines, id, change))
  }

  /** The owner has seen the conversation's newest reply. */
  markRead(id: string) {
    return this.#owner(markOwnerRead(id))
  }

  /** The owner's kept Apps (ADR 0020): keep one from a call, close or reopen it, or read what loads it. */
  createApp(input: CreateApp) {
    return this.#owner(AppPrograms.createOwnerApp(input))
  }
  updateApp(id: string, change: UpdateApp) {
    return this.#owner(AppPrograms.updateOwnerApp(id, change))
  }
  launchApp(id: string) {
    return this.#owner(AppPrograms.launchOwnerApp(id))
  }
  appSnapshot(id: string) {
    return this.#owner(AppPrograms.agentAppSnapshot(id))
  }
  appCall(id: string, call: AppCall) {
    return this.#owner(AppPrograms.callAgentApp(id, call))
  }
  appDiagnostic(id: string, diagnostic: AppDiagnostic) {
    return this.#owner(AppPrograms.reportAgentApp(id, diagnostic))
  }
  /** The owner's agent apps (ADR 0021): the list, one in full, a change to one, and deleting one. */
  agentApps() {
    return this.#owner(AppPrograms.agentAppList)
  }
  agentAppDetail(name: string) {
    return this.#owner(AppPrograms.agentAppDetail(name))
  }
  changeAgentApp(name: string, change: AgentAppChange) {
    return this.#owner(AppPrograms.changeAgentApp(name, change))
  }
  deleteAgentApp(name: string, input: DeleteAgentApp) {
    return this.#owner(AppPrograms.deleteAgentApp(name, input))
  }

  /** What a conversation lets its agent use: its switches over the agent's servers, skills and subagents. */
  conversationCapabilities(thread: string) {
    return this.#owner(capabilitiesOf(thread))
  }

  setConversationCapability(thread: string, change: CapabilityChange) {
    return this.#owner(changeCapabilities(thread, change))
  }

  modelChoice() {
    return this.#owner(Models.useSync((models) => models.choice()))
  }

  /** Stores the pick and moves main to it at once; other threads follow on their next turn. */
  chooseModel(modelId: string) {
    return this.#owner(chooseOwnerModel(this.harness, this.#applied, modelId, MAIN_THREAD))
  }

  usageToday() {
    return this.#owner(ownerUsage)
  }

  memoryStatus() {
    return this.#owner(Memory.useSync((memory) => ({ messages: memory.size(), summarized: memory.viewThrough() })))
  }

  stop(thread: string, operationId?: string) {
    return this.#owner(stopOwner({ harness: this.harness, routines: this.#routines, thread, operationId }))
  }

  mcpServers() {
    return this.#owner(ownerServers)
  }

  mcpConnect(serverId: string) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.beginConnect(serverId))))
  }

  mcpFinishConnect(state: string, code: string, issuer?: string) {
    return this.#owner(Mcp.use((mcp) => attempt(() => mcp.finishConnect(state, code, issuer))))
  }

  mcpSuggested() {
    return this.#owner(suggestedServers(this.env.STAGE))
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
    return this.#owner(removeOwnerServer(serverId))
  }
  mcpDisconnect(serverId: string) {
    return this.#owner(disconnectOwnerServer(serverId))
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
  /** Turn the agent's use of a server's skills on or off. */
  mcpSetSkills(serverId: string, enabled: boolean) {
    return this.#owner(setSkillEvents(serverId, enabled))
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
    return encodeExit(await this.#exit(setResident(enabled)))
  }

  /**
   * An inbound MCP client asks the resident agent something, in main and labelled with the client's name, so the
   * owner sees it and the agent answers with everything main knows. Needs current resident authority (it does not
   * renew it). Returns the answer, or `running` with the operation id to wait again.
   */
  askAsClient(author: string, input: string, operationId: string, waitMs: number) {
    return this.#client(
      askClient({ harness: this.harness, applied: this.#applied, author, text: input, operationId, waitMs }),
    )
  }
  /** The Telegram channel's connection, or null when it is off. */
  channelStatus() {
    return this.#owner(Channel.use((channel) => Effect.succeed(channel.status())))
  }

  /**
   * Carry Telegram through `serverId`, a myagent connection bound to the agent's own bot: grant its channel tools (an
   * explicit owner action), checkpoint its inbox and subscribe Events or the legacy doorbell.
   */
  channelEnable(serverId: string) {
    return this.#owner(
      enableTelegram(serverId, this.env.APP_URL, this.env.CREDENTIAL_KEY, this.name, () =>
        this.schedule(0, 'channelPull'),
      ),
    )
  }

  channelDisable() {
    return this.#owner(disableTelegram)
  }

  /**
   * A doorbell from myagent; the Worker already checked the hook token. Checked against the secret the agent gave
   * myagent, then answered at once: the pull runs from a schedule.
   */
  channelDoorbell(doorbell: Doorbell) {
    const pull = () => this.schedule(0, 'channelPull')
    return this.#client(
      Effect.gen(function* () {
        const channel = yield* Channel
        const secret = yield* attempt(() => channel.secret())
        const valid = secret !== undefined && (yield* attempt(() => doorbellValid(secret, doorbell, nowMillis())))
        if (!valid) return yield* new Forbidden({ reason: 'doorbell' })
        yield* attempt(pull)
        return true as const
      }),
    )
  }

  async #onChannel<T>(work: (channel: TelegramChannel, ports: ChannelPorts) => Promise<T>): Promise<T | undefined> {
    const run = <A>(program: Effect.Effect<A, AppError, AgentServices>) => this.#runOrThrow(program)
    const { mcp, channel } = await run(
      Effect.gen(function* () {
        yield* requireResident
        return { mcp: yield* Mcp, channel: yield* Channel }
      }),
    )
    const status = channel.status()
    if (status === null) return undefined
    const call = channelCall(mcp.manager, status.serverId)
    return work(channel, channelPorts(this.harness, call, run, useModel(this.harness, this.#applied, MAIN_THREAD)))
  }
  async channelPull(): Promise<void> {
    this.#pulling = this.#pulling
      .then(() => this.#onChannel((channel, ports) => channel.pull(ports, nowSeconds())))
      .then(() => undefined)
      .catch((error: unknown) => logChannelFailure('pull', error))
    await this.#pulling
  }

  async channelReplies(): Promise<void> {
    const again = await this.#onChannel(async (channel, ports) =>
      (await channel.deliver(ports, nowSeconds())) ? 15 : undefined,
    ).catch((error: unknown) => {
      logChannelFailure('replies', error)
      return 300
    })
    if (again !== undefined) await this.schedule(again, 'channelReplies')
  }
  recentMessages(limit: number) {
    return this.#client(recentOwnerMessages(this.harness, limit))
  }

  /** Erases the agent: its files in R2 first (a failure leaves everything to retry), then services and storage. */
  async deleteAgentData(): Promise<RpcResult<true>> {
    const files = new FileStore(this.ctx.storage.sql, this.env.FILES, () => this.name)
    const purged = await Effect.runPromiseExit(attempt(() => files.purge()))
    if (Exit.isFailure(purged)) return encodeExit(Exit.map(purged, (): true => true))
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
  async #client<A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<RpcResult<A>> {
    return encodeExit(
      await this.#exit(
        Effect.andThen(
          Entitlements.use((plans) => plans.require()),
          program,
        ),
      ),
    )
  }
  async sessionSnapshot(session: string): Promise<JsonObject> {
    return sessionSnapshot(this.harness, session)
  }
  override async onRequest(request: Request): Promise<Response> {
    return agentRequest(request, this.harness, (program) => this.#exit(program))
  }
}
