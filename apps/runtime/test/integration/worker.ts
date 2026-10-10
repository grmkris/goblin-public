import type { ProviderStreams } from '@earendil-works/pi-ai'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import * as Effect from 'effect/Effect'
import { nextInt } from 'effect/Random'
import { JOB_CALLBACK } from '../../src/agent-apps/jobs.ts'
import { PersonalAgent } from '../../src/agent.ts'
import type { EntitlementPolicy } from '../../src/billing/gates.ts'
import { ChatDirectory } from '../../src/chats/directory.ts'
import { canonicalRedirect } from '../../src/http/canonical.ts'
import { Internal } from '../../src/http/errors.ts'
import { listTables } from '../../src/storage/vendor.ts'
import { EventsFixture } from '../mcp/events-fixture.ts'
import { probes as agentProbes, startupCheck } from './agent-probe.ts'
import { probes as appsJobsProbes } from './apps-jobs-probe.ts'
import { probes as appsProbes } from './apps-probe.ts'
import { probes as budgetProbes } from './budget-outage.ts'
import { probes as codeRecoveryProbes } from './code-recovery-probe.ts'
import { probes as composerProbes } from './composer-probe.ts'
import { probes as conversationProbes } from './conversation-probe.ts'
import { probes as decisionsProbes } from './decisions-probe.ts'
import { probes as ingressProbes } from './events-ingress-case.ts'
import { probes as eventsProbes } from './events-probe.ts'
import { probes as filesProbes } from './files-probe.ts'
import { probes as homeProbes } from './home-probe.ts'
import { inboundHostProbe } from './inbound-host.ts'
import { probes as inboxProbes } from './inbox-app-probe.ts'
import { probes as lifecycleProbes } from './lifecycle-probe.ts'
import { type SeenRequest, scriptedStreams } from './model.ts'
import { probes as primaryProbes } from './native-chats.ts'
import { probes as conversationOpsProbes } from './native-conversation-ops.ts'
import { probes as delegationProbes } from './native-delegation.ts'
import { probes as memoryProbes } from './native-memory.ts'
import { probes as scopeProbes } from './native-scopes.ts'
import { probes as topicProbes } from './native-topics.ts'
import { permutePrimary, profileEnabled } from './primary-profile.ts'
import { type Inside, type ProbeEnv, registry } from './probe.ts'
import { probes as routineEventsProbes } from './routines-events.ts'
import { probes as routineExecutionProbes } from './routines-execution.ts'
import { probes as routineNotificationProbes } from './routines-notifications.ts'
import { probes as routinesProbes } from './routines-probe.ts'
import { probes as routineSafetyProbes } from './routines-safety.ts'
import { probes as routineSchedulingProbes } from './routines-scheduling.ts'
import { probes as routineUsageProbes } from './routines-usage.ts'
import { probes as skillsProbes } from './skills-probe.ts'
import { probes as subagentProbes } from './subagent-probe.ts'
import { probes as telemetryProbes } from './telemetry-probe.ts'

export { NativeLifecycleProbe } from './lifecycle-probe.ts'

/** Every probe of the native worker by name (`GET /probe/<name>?name=<agent>`). */
const PROBES = registry(
  agentProbes,
  appsJobsProbes,
  appsProbes,
  budgetProbes,
  codeRecoveryProbes,
  composerProbes,
  conversationOpsProbes,
  conversationProbes,
  decisionsProbes,
  delegationProbes,
  eventsProbes,
  filesProbes,
  homeProbes,
  inboxProbes,
  ingressProbes,
  lifecycleProbes,
  memoryProbes,
  primaryProbes,
  routineEventsProbes,
  routineExecutionProbes,
  routineNotificationProbes,
  routineSafetyProbes,
  routineSchedulingProbes,
  routineUsageProbes,
  routinesProbes,
  scopeProbes,
  skillsProbes,
  subagentProbes,
  telemetryProbes,
  topicProbes,
)

const fixturePlan = () =>
  Effect.succeed({
    active: true,
    source: 'override' as const,
    until: null,
    dailyCredits: 300_000,
    status: 'fixture',
    hasCustomer: false,
    cancelAtPeriodEnd: false,
  })

/** A plan lookup while auth D1 is down (the budget outage probe). */
const planOutage = () => Effect.fail(new Internal({ reason: 'auth D1 unavailable' }))

/** The actual PersonalAgent on a scripted model (no network): every request it makes is kept for the test to read. */
export class PersonalAgentProbe extends PersonalAgent {
  readonly seen: SeenRequest[] = []
  readonly instance = String(Effect.runSync(nextInt))
  readonly #producer = new EventsFixture()
  /** The agent's APIs as the Worker reaches them, for the probes that call them from inside the object. */
  readonly #api = { fetch: (request: Request) => this.onRequest(request) }
  /** The tables as the constructor left them, before the lifecycle's start opens Pi (its apps read `app_` ones). */
  readonly #constructed = listTables(this.ctx.storage).map(({ name }) => name)
  /** Which coming plan lookup fails, counted down (the Events ingress probe arms it); 0 for none. */
  #failPlanAt = 0
  /** Set by the budget outage probe: no plan lookup succeeds (auth D1 down). */
  #planOutage = false

  modelRequestCount(): number {
    return this.seen.length
  }

  override async onStart(): Promise<void> {
    await super.onStart()
    if (profileEnabled(this.env)) await permutePrimary(this.ctx.storage, this.harness)
  }

  protected override entitlementPolicy(): EntitlementPolicy {
    const state = () => Effect.suspend(() => (this.#planOutage ? planOutage() : fixturePlan()))
    const require = () =>
      Effect.suspend(() => {
        if (this.#planOutage) return planOutage()
        return this.#failPlanAt > 0 && --this.#failPlanAt === 0
          ? Effect.fail(new Internal({ reason: 'fixture plan lookup failed' }))
          : fixturePlan()
      })
    return { state, require }
  }

  protected override mcpFetch(): typeof fetch {
    return (input, init) =>
      new URL(input instanceof Request ? input.url : String(input)).hostname === 'routine-events.test'
        ? this.#producer.fetch(input, init)
        : fetch(input, init)
  }

  protected override modelStreams(): ProviderStreams {
    return scriptedStreams(
      (request) => this.seen.push(request),
      undefined,
      (messages) =>
        messages.some((message) => message.content === 'Native slow job')
          ? 3000
          : messages.some(
                (message) => typeof message.content === 'string' && message.content.includes('Native slow routine'),
              )
            ? 1000
            : 0,
    )
  }

  /** Waits for an operation in a conversation to settle (the owner API has no wait route). */
  async settle(chat: string, operationId: string) {
    const directory = new ChatDirectory(drizzle(this.ctx.storage))
    const session = directory.operation(chat, operationId) ?? directory.session(chat)
    return this.harness.wait(operationId, { session })
  }

  /** Whether Pi runs a conversation now (the workspace feed carries this; the conversation list does not). */
  async busy(chat: string): Promise<boolean> {
    const directory = new ChatDirectory(drizzle(this.ctx.storage))
    return this.harness.session(directory.session(chat)).busy()
  }

  /**
   * The newest model request that answered `turn` (its last non-system message), as plain data: deep readonly types
   * do not cross the RPC stub. Matching the turn keeps the cheap model's own requests (thread titles) out of it.
   */
  requestFor(
    turn: string,
  ): { messages: { role: string; text: string }[]; systemPrompt: string; tools: string[] } | undefined {
    const request = this.seen.findLast(
      ({ messages }) => messages.findLast((message) => message.role !== 'system')?.text === turn,
    )
    if (request === undefined) return undefined
    return {
      messages: request.messages.map(({ role, text }) => ({ role, text })),
      systemPrompt: request.systemPrompt,
      tools: [...request.tools],
    }
  }

  /** One probe of the registry that runs inside the agent; its answer as JSON text (RPC types cannot carry `unknown`). */
  async probe(name: string): Promise<string> {
    const probe = PROBES[name]
    if (probe?.where !== 'agent') throw new Error(`no probe ${name} runs inside the agent`)
    return JSON.stringify(await probe.run(this.#inside()))
  }

  /** What a probe inside the agent works on. */
  #inside(): Inside {
    return {
      agent: this,
      storage: this.ctx.storage,
      harness: this.harness,
      env: this.env,
      name: this.name,
      seen: this.seen,
      api: this.#api,
      schedules: {
        list: () => this.listSchedules(),
        arm: async (at, slot) => (await this.schedule(new Date(at), JOB_CALLBACK, slot, { idempotent: true })).id,
        cancel: (id) => this.cancelSchedule(id),
      },
      fire: (slot) => this.runAppJob(slot),
      plan: {
        failAt: (nth) => {
          this.#failPlanAt = nth
        },
        outage: (on) => {
          this.#planOutage = on
        },
      },
      producer: this.#producer,
      evict: (reason) => this.ctx.abort(reason),
    }
  }

  /** `/test/startup` checks the start (`startupCheck`); every other path is the real agent's. */
  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/test/startup') return super.onRequest(request)
    return startupCheck(this.ctx.storage, this.#constructed, this.#api)
  }
}

/** A failure as the probe route answers it: its name, message and stack, for the case's assertion to show. */
const failed = (cause: unknown) =>
  new Response(cause instanceof Error ? (cause.stack ?? `${cause.name}: ${cause.message}`) : String(cause), {
    status: 500,
  })

/** `GET /probe/<name>?name=<agent>`: one probe, inside the agent named or in the Worker against its stub. */
async function probeRoute(url: URL, env: ProbeEnv): Promise<Response> {
  const probeName = url.pathname.slice('/probe/'.length)
  const probe = PROBES[probeName]
  if (probe === undefined) return new Response(`no probe ${probeName}`, { status: 404 })
  const name = url.searchParams.get('name') ?? 'initialization'
  const agent = env.AGENTS.getByName(name)
  try {
    const json =
      probe.where === 'agent'
        ? await agent.probe(probeName)
        : JSON.stringify(await probe.run({ agent, name, url, env }))
    return new Response(json, { headers: { 'content-type': 'application/json' } })
  } catch (cause) {
    // expected: a probe that throws answers 500 with what it threw, which its case shows
    return failed(cause)
  }
}

export default {
  fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/probe/')) return probeRoute(url, env)
    if (url.pathname === '/inbound-host') return inboundHostProbe(request)
    if (url.pathname.startsWith('/canonical'))
      return Promise.resolve(canonicalRedirect(request, 'https://goblin.surf') ?? Response.json({ canonical: true }))
    return Promise.resolve(new Response('not found', { status: 404 }))
  },
}
