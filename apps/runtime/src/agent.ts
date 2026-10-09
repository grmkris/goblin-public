import { Agent } from 'agents'
import { type Extension } from '@earendil-works/pi-durable'
import { PiHarness } from 'agents/harness/pi'
import type { ProviderStreams } from '@earendil-works/pi-ai'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import type { AgentRpcMethods, RuntimeEnv } from './env.ts'
import { type AppError, toAppError } from './http/errors.ts'
import { ChannelWakes } from './channel/wake.ts'
import { type Doorbell } from './channel/doorbell.ts'
import { type RpcResult, encodeExit } from './http/rpc.ts'
import { FileStore } from './files/store.ts'
import { filesExtension } from './pi/files.ts'
import { type AgentApps, agentApps } from './agent-apps/engine.ts'
import { JOB_CALLBACK, type JobSchedules, type JobSlot } from './agent-apps/jobs.ts'
import { reconcileAppJobs, runAppJob } from './agent-apps/wake.ts'
import { mcpEventsWake } from './mcp/wake.ts'
import { routinesWake, runRoutine, runRoutineDeadline } from './routines/wake.ts'
import { appsExtension, appExecutionExtension } from './pi/apps.ts'
import { serversExtension } from './pi/servers.ts'
import { agentRequest } from './agent-requests.ts'
import { type PiModels, makePiHarness } from './pi/harness.ts'
import { type AgentTelemetry, agentTelemetry } from './telemetry/agent.ts'
import { LITELLM_STREAMS, makePiModels } from './pi/model.ts'
import { personaExtension } from './pi/persona.ts'
import { type SubagentKit, subagentsExtension } from './pi/subagents.ts'
import { threadExtension } from './pi/thread.ts'
import { type PersonaTurnKit, organizingKit } from './organize/kit.ts'
import { memoryExtensions } from './pi/memory.ts'
import { residentMcpExtension } from './pi/resident-mcp.ts'
import { skillLearningExtension, skillsExtension } from './pi/skills.ts'
import { AgentLive } from './layers/index.ts'
import { type AgentServices } from './services.ts'
import { accountEntitlements, type EntitlementPolicy } from './billing/gates.ts'
import { type Bridge, closeRuntime, makeBridge, openRuntime } from './runtime/bridge.ts'
import type { AgentInputs } from './runtime/input.ts'
import { type Instrument, reported } from './runtime/instrument.ts'
import { OwnerHttp } from './http/api/server.ts'
import { runApplicationMigrations } from './storage/migrations.ts'
import { nowSeconds } from './clock.ts'
import { Events, type EventWebhook } from './mcp/events.ts'
import { acceptDoorbell } from './channel/program.ts'
import { askClient, clientRequest, recentOwnerMessages } from './agent-program.ts'
import { type MovePhase } from './chats/mover.ts'
import { budgetExtension } from './pi/budget.ts'
import { retrievalExtension } from './pi/retrieval.ts'
import { type Applied } from './agent-model.ts'
import { routinesExtension } from './pi/routines.ts'
import { requireRoutine, requireRoutineSession } from './routines/authority.ts'
import type { RoutineSlot } from './routines/scheduler.ts'
import { RoutineController, routineExtensions, routineSchedulePorts } from './routines/controller.ts'

type Runtime = ManagedRuntime.ManagedRuntime<AgentServices, never>

/** How each program and change handler the agent runs is wrapped: the bridge and the Changes bus take this one. */
const instrument: Instrument = reported

/**
 * The resident agent. Pi (through the native PiHarness) owns conversations; the services in `services.ts` own MCP
 * connections, credentials, grants and resident authority. The owner reaches it through its typed API (`onRequest`);
 * the five RPC methods left are for the Worker's other callers (an inbound client, myagent, MCP Events, account
 * erasure), each one program.
 */
export class PersonalAgent extends Agent<RuntimeEnv> implements AgentRpcMethods {
  readonly harness: PiHarness
  readonly #pi: PiModels
  readonly #thread: Extension
  readonly #memory: ReturnType<typeof memoryExtensions>
  readonly #subagents: SubagentKit
  readonly #personas: PersonaTurnKit
  readonly #applied: Applied = new Map()
  readonly #routines: RoutineController
  readonly #apps: AgentApps
  readonly #telemetry: AgentTelemetry
  /** How the object runs its programs (runtime/bridge.ts). */
  readonly #bridge: Bridge
  /** The Telegram channel alarms (channel/wake.ts). */
  readonly #channel: ChannelWakes
  #runtime: Promise<Runtime> | undefined
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env)
    this.#bridge = makeBridge(() => this.#services(), { instrument })
    const { run, local: routineRun } = this.#bridge
    this.#pi = makePiModels(env, this.modelStreams(), undefined, (id) => routineRun(requireRoutine(id)))
    const residentTools = residentMcpExtension(run, (session) => routineRun(requireRoutineSession(session)))
    const tools = [residentTools, budgetExtension(run)]
    this.#thread = threadExtension(run)
    this.#memory = memoryExtensions(run)
    const { memory, recall } = this.#memory
    const routineKit = routineExtensions(routineRun, residentTools, env.CREDENTIAL_KEY)
    const apps = agentApps(ctx.storage, env, () => this.name, { schedules: this.#jobSchedules(), local: routineRun })
    this.#apps = apps
    this.#telemetry = agentTelemetry(ctx.storage, () => this.name, routineRun)
    const execution = [...tools, skillsExtension(run), filesExtension(run), appExecutionExtension(apps)]
    this.#subagents = subagentsExtension(run, (self) => [personaExtension, ...execution, ...apps.extensions(), self])
    const subagents = this.#subagents.extension
    const { personas, organize } = organizingKit(run, () => this.#stopping())
    this.#personas = personas
    const retrieval = retrievalExtension(run)
    const base = [...execution, skillLearningExtension(run), ...appsExtension(apps, run), organize, retrieval]
    const own = [serversExtension(run, env.STAGE), subagents, routinesExtension(run), this.#telemetry.diagnose]
    const extras = [this.#thread, memory, recall, this.#personas.extension, ...routineKit.extra]
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
    const again = (seconds: number) => this.schedule(seconds, 'channelReplies')
    this.#channel = new ChannelWakes({ harness: this.harness, applied: this.#applied, run, again })
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
    await reconcileAppJobs(this.#apps)
  }

  /** Tests inject account authority here; the deployed object always reads its own account in auth D1. */
  protected entitlementPolicy(): EntitlementPolicy {
    return accountEntitlements(this.env, () => this.name)
  }
  #services(): Promise<Runtime> {
    this.#runtime ??= openRuntime(ManagedRuntime.make(AgentLive(this.#input())))
    this.#runtime.catch(() => {
      this.#runtime = undefined
    })
    return this.#runtime
  }
  /** What the agent's services are built from, read when the runtime is built (AgentInput). */
  #input(): AgentInputs {
    return {
      storage: this.ctx.storage,
      env: this.env,
      harness: this.harness,
      pi: this.#pi,
      thread: this.#thread,
      memory: this.#memory,
      subagentTools: this.#subagents.tools,
      helperExtensions: this.#subagents.members(),
      scheduleReplies: () => void this.schedule(5, 'channelReplies'),
      userId: this.name,
      entitlements: this.entitlementPolicy(),
      scheduleEvents: (at) => this.#scheduleWake('mcpEventsWake', at),
      pullTelegram: () => this.channelPull(),
      schedulePull: () => this.schedule(0, 'channelPull'),
      routineEvent: (context) => this.#routines.consumeEvent(context),
      mcpFetch: this.mcpFetch(),
      agentApps: this.#apps,
      telemetry: this.#telemetry.telemetry,
      moves: {
        handover: this.#subagents.handover,
        after: async (phase, operation) => this.moveBoundary(phase, operation),
      },
      subagents: this.#subagents,
      personas: this.#personas,
      applied: this.#applied,
      routines: this.#routines,
      run: this.#bridge.run,
      local: this.#bridge.local,
      stopping: this.#stopping,
      instrument,
    }
  }
  /** A move committed `phase`; the integration harness stops the object here to prove a restart finishes it. */
  protected async moveBoundary(_phase: MovePhase, _operation: string): Promise<void> {}
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
  // The schedule callbacks: the Agents SDK calls them by name; each body lives in its area's wake.ts.
  async mcpEventsWake(): Promise<void> {
    await mcpEventsWake(this.#bridge.run, (at) => this.#scheduleWake('mcpEventsWake', at))
  }
  async routinesWake(): Promise<void> {
    await routinesWake(this.#routines, (at) => this.#scheduleWake('routinesWake', at))
  }
  async runRoutine(slot: RoutineSlot): Promise<void> {
    await runRoutine(this.#routines, slot)
  }
  async runRoutineDeadline(input: { runId: string }): Promise<void> {
    await runRoutineDeadline(this.#routines, input)
  }
  /** An agent app's job is due (ADR 0021). */
  async runAppJob(slot: JobSlot): Promise<void> {
    await runAppJob(this.#apps, slot)
  }

  /** What an archive or a Stop reaches: Pi, a routine's runs and the Persona turns asked in a chat. */
  readonly #stopping = () => ({ harness: this.harness, routines: this.#routines, personas: this.#personas })

  /**
   * An inbound MCP client asks the resident agent something, in main and labelled with the client's name, so the
   * owner sees it and the agent answers with everything main knows. Needs current resident authority (it does not
   * renew it). Returns the answer, or `running` with the operation id to wait again.
   */
  askAsClient(author: string, input: string, operationId: string, waitMs: number) {
    const runtime = { harness: this.harness, applied: this.#applied }
    return this.#client(askClient({ ...runtime, author, text: input, operationId, waitMs }, this.#bridge.run))
  }
  /**
   * A doorbell from myagent; the Worker already checked the hook token. Checked against the secret the agent gave
   * myagent, then answered at once: the pull runs from a schedule.
   */
  channelDoorbell(doorbell: Doorbell) {
    return this.#client(acceptDoorbell(doorbell, () => this.schedule(0, 'channelPull')))
  }

  async channelPull(): Promise<void> {
    await this.#channel.pull()
  }
  async channelReplies(): Promise<void> {
    await this.#channel.replies()
  }
  recentMessages(limit: number) {
    return this.#client(recentOwnerMessages(this.harness, limit))
  }

  /** Erases the agent: its files in R2 first (a failure leaves everything to retry), then services and storage. */
  async deleteAgentData(): Promise<RpcResult<true>> {
    const files = new FileStore(this.ctx.storage.sql, this.env.FILES, () => this.name)
    try {
      await files.purge()
    } catch (cause) {
      return encodeExit(Exit.fail(toAppError(cause)))
    }
    const runtime = this.#runtime
    this.#runtime = undefined
    if (runtime !== undefined) await closeRuntime(runtime)
    await this.destroy()
    return { ok: true, value: true }
  }
  async #client<A>(program: Effect.Effect<A, AppError, AgentServices>): Promise<RpcResult<A>> {
    return encodeExit(await this.#bridge.exit(clientRequest(program)))
  }
  /**
   * The owner API first (http/api/server.ts); any other path is one of the agent's raw routes (agent-requests.ts). Only
   * the Worker reaches either: it admits the owner and forwards `/api/*` unchanged (http/api/edge.ts).
   */
  override async onRequest(request: Request): Promise<Response> {
    const served = await this.#bridge.exit(OwnerHttp.use((http) => http.handle(request)))
    if (Exit.isSuccess(served) && Option.isSome(served.value)) return served.value.value
    return agentRequest(request, this.harness, this.#bridge.exit, this.env.APP_URL)
  }
}
