import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import * as Context from 'effect/Context'
import type { AgentApps } from '../agent-apps/engine.ts'
import type { Applied } from '../agent-model.ts'
import type { EntitlementPolicy } from '../billing/gates.ts'
import type { MoverPorts } from '../chats/mover.ts'
import type { RuntimeEnv } from '../env.ts'
import type { PersonaTurnKit } from '../organize/kit.ts'
import type { PiModels } from '../pi/harness.ts'
import type { memoryExtensions } from '../pi/memory.ts'
import type { StartRoutine } from '../pi/routine-run.ts'
import type { SubagentKit } from '../pi/subagents.ts'
import type { RoutineSchedules } from '../routines/scheduler.ts'
import type { RunTelemetry } from '../telemetry/events.ts'
import type { RunProgram } from './bridge.ts'
import type { Instrument } from './instrument.ts'

/**
 * What the agent's programs and services need from its Durable Object instance, as one record: its storage and env,
 * the Pi pieces its constructor made, and the callbacks into the instance (schedules, the plan policy). A program
 * reads it instead of taking these as arguments. Built once per runtime from the instance (agent.ts).
 */
export interface AgentInputs {
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
  /** The native schedules the routines arm and cancel, and their sweep's alarm (routines/wake.ts). */
  readonly routineSchedules: RoutineSchedules
  /** Starts a routine run's Pi work: the routines kit's, made before Pi opened (routines/kit.ts). */
  readonly startRoutine: StartRoutine
  /** Schedules the Telegram replies alarm. */
  readonly scheduleReplies: () => void
  readonly scheduleEvents: (at: number) => Promise<void>
  /** Schedules the Telegram pull alarm (channelPull) at once: what a doorbell or a Telegram event asks for. */
  readonly schedulePull: () => Promise<unknown>
  readonly mcpFetch: typeof fetch
  /** The agent's apps, made before Pi opened (their tools are Pi's). */
  readonly agentApps: AgentApps
  /** The run ledger and log lines the agent's services report to (ADR 0024). */
  readonly telemetry: RunTelemetry
  /** Move to thread (ADR 0034): hands the moved turn's relays to the Thread, and the boundaries tests stop at. */
  readonly moves: MoverPorts
  readonly entitlements: EntitlementPolicy
  /** Runs a program after the plan check, as an owner's or the agent's request does. */
  readonly run: RunProgram
  /** Runs a program without the plan check (ledger, budget record, routine gates, diagnose). */
  readonly local: RunProgram
  /** How the bridge's programs and the change handlers are wrapped (instrument.ts). */
  readonly instrument: Instrument
}

/** The agent's inputs as a service, provided once per runtime (layers/core.ts). */
export class AgentInput extends Context.Service<AgentInput, AgentInputs>()('goblin/runtime/AgentInput') {}
