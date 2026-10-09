import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AgentApps } from '../agent-apps/engine.ts'
import type { Applied } from '../agent-model.ts'
import type { StopRuntime } from '../agent-program.ts'
import type { EntitlementPolicy } from '../billing/gates.ts'
import type { MoverPorts } from '../chats/mover.ts'
import type { RuntimeEnv } from '../env.ts'
import type { AppError } from '../http/errors.ts'
import type { EventHandler } from '../mcp/events/dispatcher.ts'
import type { PersonaTurnKit } from '../organize/kit.ts'
import type { PiModels } from '../pi/harness.ts'
import type { memoryExtensions } from '../pi/memory.ts'
import type { SubagentKit } from '../pi/subagents.ts'
import type { RoutineController } from '../routines/controller.ts'
import type { AgentServices } from '../services.ts'
import type { RunTelemetry } from '../telemetry/events.ts'

type Run = <A>(program: Effect.Effect<A, AppError, AgentServices>) => Promise<A>

/**
 * What the agent's programs and services need from its Durable Object instance, as one record: its storage and env,
 * the Pi pieces its constructor made, and the callbacks into the instance (schedules, the plan policy, Stop). A program
 * reads it instead of taking these as arguments. Built once per runtime from the instance (agent.ts).
 */
export class AgentInput extends Context.Service<
  AgentInput,
  {
    readonly storage: DurableObjectStorage
    readonly env: RuntimeEnv
    readonly userId: string
    readonly harness: PiHarness
    readonly pi: PiModels
    readonly thread: Extension
    readonly memory: ReturnType<typeof memoryExtensions>
    /** The subagent tools, which Pi's tool filter removes where subagents are switched off. */
    readonly subagentTools: readonly ToolRegistration[]
    readonly helperExtensions: readonly Extension[]
    readonly subagents: SubagentKit
    readonly personas: PersonaTurnKit
    /** The model each session was last put on (agent-model.ts). */
    readonly applied: Applied
    readonly routines: RoutineController
    /** Schedules the Telegram replies alarm. */
    readonly scheduleReplies: () => void
    readonly scheduleEvents: (at: number) => Promise<void>
    readonly pullTelegram: () => Promise<void>
    readonly routineEvent: EventHandler
    readonly mcpFetch: typeof fetch
    /** The agent's apps, made before Pi opened (their tools are Pi's). */
    readonly agentApps: AgentApps
    /** The run ledger and log lines the agent's services report to (ADR 0024). */
    readonly telemetry: RunTelemetry
    /** Move to thread (ADR 0034): hands the moved turn's relays to the Thread, and the boundaries tests stop at. */
    readonly moves: Pick<MoverPorts, 'handover' | 'after'>
    readonly entitlements: EntitlementPolicy
    /** Runs a program after the plan check, as an owner's or the agent's request does. */
    readonly run: Run
    /** Runs a program without the plan check (ledger, budget record, routine gates, diagnose). */
    readonly local: Run
    /** What an archive or a Stop reaches: Pi, a routine's runs and the Persona turns asked in a chat. */
    readonly stopping: () => StopRuntime
  }
>()('goblin/runtime/AgentInput') {}
