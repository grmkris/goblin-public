import { Agent } from 'agents'
import { type Extension } from '@earendil-works/pi-durable'
import { PiHarness } from 'agents/harness/pi'
import type { ProviderStreams } from '@earendil-works/pi-ai'
import * as Exit from 'effect/Exit'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import type { AgentRpcMethods, RuntimeEnv } from './env.ts'
import { failureOf, toAppError } from './http/errors.ts'
import { channelPull, channelReplies } from './channel/wake.ts'
import { type RpcResult, encodeExit } from './http/rpc.ts'
import { filesExtension } from './pi/files.ts'
import { type AgentApps, agentApps } from './agent-apps/engine.ts'
import { appPorts } from './agent-apps/ports.ts'
import { JOB_CALLBACK, type JobSchedules, type JobSlot } from './agent-apps/jobs.ts'
import { reconcileAppJobs, runAppJob } from './agent-apps/wake.ts'
import { mcpEventsWake } from './mcp/wake.ts'
import { routineSchedulePorts, routinesWake, runRoutine, runRoutineDeadline } from './routines/wake.ts'
import { appsExtension, appExecutionExtension } from './pi/apps.ts'
import { serversExtension } from './pi/servers.ts'
import { type PiModels, makePiHarness } from './pi/harness.ts'
import { type AgentTelemetry, agentTelemetry } from './telemetry/agent.ts'
import { LITELLM_STREAMS, type PayChallenge, makePiModels } from './pi/model.ts'
import { payInferenceChallenge, paymentFailureText, settleInferencePayment } from './mcp/inference-pay.ts'
import { personaExtension } from './pi/persona.ts'
import { type SubagentKit, subagentsExtension } from './pi/subagents.ts'
import { threadExtension } from './pi/thread.ts'
import { type PersonaTurnKit, organizingKit } from './organize/kit.ts'
import { type MemoryKit, memoryExtensions } from './pi/memory.ts'
import { residentMcpExtension } from './pi/resident-mcp.ts'
import { skillLearningExtension, skillsExtension } from './pi/skills.ts'
import { AgentLive } from './layers/index.ts'
import type { AgentServices } from './layers/index.ts'
import { accountEntitlements, type EntitlementPolicy } from './billing/gates.ts'
import { type Bridge, makeBridge, openRuntime } from './runtime/bridge.ts'
import type { AgentInputs } from './runtime/input.ts'
import { type Instrument, reported } from './runtime/instrument.ts'
import { AgentHttp } from './http/api/server.ts'
import { forwardedRef } from './http/api/context.ts'
import { refusal } from './http/api/render.ts'
import { runApplicationMigrations } from './storage/migrations.ts'
import { nowSeconds } from './clock.ts'
import { type MovePhase } from './chats/mover.ts'
import { budgetExtension } from './pi/budget.ts'
import { decisionsExtension } from './pi/decisions.ts'
import { retrievalExtension } from './pi/retrieval.ts'
import { type Applied } from './agent-model.ts'
import { routinesExtension } from './pi/routines.ts'
import { requireRoutine } from './routines/authority.ts'
import type { RoutineSlot } from './routines/scheduler.ts'
import { routineExtensions } from './routines/kit.ts'
import type { StartRoutine } from './pi/routine-run.ts'

type Runtime = ManagedRuntime.ManagedRuntime<AgentServices, never>

/** How each program and change handler the agent runs is wrapped: the bridge and the Changes bus take this one. */
const instrument: Instrument = reported

/**
 * The resident agent. Pi (through the native PiHarness) owns conversations; the services in `layers/` own MCP
 * connections, credentials, grants and resident authority. The owner reaches it through its typed API and the Worker's
 * other callers (an inbound client, myagent, MCP Events) through the internal one, both over `fetch` (`onRequest`);
 * the one RPC method left erases the account.
 */
export class PersonalAgent extends Agent<RuntimeEnv> implements AgentRpcMethods {
  readonly harness: PiHarness
  readonly #pi: PiModels
  readonly #thread: Extension
  readonly #memory: MemoryKit
  readonly #subagents: SubagentKit
  readonly #personas: PersonaTurnKit
  readonly #applied: Applied = new Map()
  /** How a routine run's Pi work starts (the routines kit's, routines/kit.ts). */
  readonly #routineStart: StartRoutine
  readonly #apps: AgentApps
  readonly #telemetry: AgentTelemetry
  /** How the object runs its programs (runtime/bridge.ts). */
  readonly #bridge: Bridge
  #runtime: Promise<Runtime> | undefined
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env)
    // The application tables, before anything reads them: the lifecycle opens Pi (whose apps and ledger read them)
    // before onStart, and an RPC or the runtime may come first too. Synchronous, as the Agents SDK's own schema is.
    runApplicationMigrations(ctx.storage)
    this.#bridge = makeBridge(() => this.#services(), { instrument })
    const { run, local: routineRun } = this.#bridge
    // Paid inference pays each model call from the owner's Goblin Wallet (ADR 0047); a refusal ends the call in words.
    const pay: PayChallenge = (request) =>
      routineRun(payInferenceChallenge(request)).then(
        ({ credential, payment }) => ({
          credential,
          settle: (receipt: string) => routineRun(settleInferencePayment(payment, receipt)),
        }),
        (error: unknown) => {
          throw new Error(paymentFailureText(error))
        },
      )
    this.#pi = makePiModels(env, this.modelStreams(), undefined, (id) => routineRun(requireRoutine(id)), pay)
    const residentTools = residentMcpExtension(run)
    const tools = [residentTools, budgetExtension(routineRun)]
    this.#thread = threadExtension(run)
    this.#memory = memoryExtensions(run)
    const { memory, recall } = this.#memory
    const { personas, organize } = organizingKit(run)
    this.#personas = personas
    const routineKit = routineExtensions(routineRun, residentTools, personas.extension, env.CREDENTIAL_KEY)
    this.#routineStart = routineKit.start
    const apps = agentApps(ctx.storage, env, () => this.name, {
      schedules: this.#jobSchedules(),
      ...appPorts(this.#bridge),
    })
    this.#apps = apps
    this.#telemetry = agentTelemetry(ctx.storage, () => this.name, routineRun)
    const execution = [...tools, skillsExtension(run), filesExtension(run), appExecutionExtension(apps, run)]
    this.#subagents = subagentsExtension(run, (self) => [personaExtension, ...execution, ...apps.extensions(), self])
    const subagents = this.#subagents.extension
    const retrieval = retrievalExtension(run)
    const learning = [skillLearningExtension(run), decisionsExtension(run, env.AI !== undefined)]
    const base = [...execution, ...learning, ...appsExtension(apps, run), organize, retrieval]
    const own = [serversExtension(run, env.STAGE), subagents, routinesExtension(run), this.#telemetry.diagnose]
    const extras = [this.#thread, memory, recall, this.#personas.extension, ...routineKit.extra]
    this.harness = makePiHarness(this.#pi, [...base, ...own], extras, apps, this.#telemetry.recorder)
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
    // expected: every caller awaiting the runtime gets its start failure; this only lets the next caller start again
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
      schedulePull: () => this.schedule(0, 'channelPull'),
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
      routineSchedules: routineSchedulePorts({
        list: () => this.listSchedules(),
        cancel: (id) => this.cancelSchedule(id),
        armNative: (at, payload) => this.schedule(at, 'runRoutine', payload, { idempotent: true }),
        deadlineNative: (at, payload) => this.schedule(at, 'runRoutineDeadline', payload, { idempotent: true }),
        wake: (at) => this.#scheduleWake('routinesWake', at),
      }),
      startRoutine: this.#routineStart,
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
  // The schedule callbacks: the Agents SDK calls them by name; each body lives in its area's wake.ts.
  async mcpEventsWake(): Promise<void> {
    await this.#bridge.local(mcpEventsWake)
  }
  async routinesWake(): Promise<void> {
    await routinesWake(this.#bridge.local, (at) => this.#scheduleWake('routinesWake', at))
  }
  async runRoutine(slot: RoutineSlot): Promise<void> {
    await runRoutine(this.#bridge.local, slot)
  }
  async runRoutineDeadline(input: { runId: string }): Promise<void> {
    await runRoutineDeadline(this.#bridge.local, input)
  }
  /** An agent app's job is due (ADR 0021). */
  async runAppJob(slot: JobSlot): Promise<void> {
    await runAppJob(this.#apps, slot)
  }

  /** The Telegram channel's alarms (channel/wake.ts): one pull, and the ready answers sent. */
  async channelPull(): Promise<void> {
    await channelPull(this.#bridge.run)
  }
  async channelReplies(): Promise<void> {
    await channelReplies(this.#bridge.run, (seconds) => this.schedule(seconds, 'channelReplies'))
  }

  /** Erases the agent: its files in R2 first (a failure leaves everything to retry), then services and storage. */
  async deleteAgentData(): Promise<RpcResult<true>> {
    try {
      await this.#apps.ownerFiles.purge()
    } catch (cause) {
      return encodeExit(Exit.fail(toAppError(cause)))
    }
    const runtime = this.#runtime
    this.#runtime = undefined
    // Disposing runs the layers' finalizers, which close the MCP connections.
    // expected: a runtime that failed to build has nothing to dispose, and its callers already had its failure
    await (await runtime?.catch(() => undefined))?.dispose()
    await this.destroy()
    return { ok: true, value: true }
  }
  /**
   * The agent's typed APIs (http/api/server.ts), the one way in over `fetch`; a runtime that failed to start answers
   * its failure in the envelope. Only the Worker reaches it: it admits the owner and forwards `/api/*`
   * (http/api/edge.ts), and calls the internal API after its own check of the caller.
   */
  override async onRequest(request: Request): Promise<Response> {
    const served = await this.#bridge.exit(AgentHttp.use((http) => http.handle(request)))
    return Exit.isSuccess(served) ? served.value : refusal(failureOf(served.cause), forwardedRef(request))
  }
}
