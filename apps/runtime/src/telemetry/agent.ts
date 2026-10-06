import type { Extension } from '@earendil-works/pi-durable'
import * as workers from 'cloudflare:workers'
import { diagnoseExtension } from '../pi/diagnose.ts'
import type { RunProgram } from '../pi/resident-mcp.ts'
import { type RunTelemetryKit, runTelemetry } from './run.ts'
import { TraceSink } from './trace.ts'

/** The agent's telemetry and its own read-only `diagnose` tool over the ledger, for main. */
export type AgentTelemetry = RunTelemetryKit & { readonly diagnose: Extension }

/** The agent's run telemetry: the ledger and log, its model and tool calls as spans in the Cloudflare trace. */
export function agentTelemetry(storage: DurableObjectStorage, agent: () => string, run: RunProgram): AgentTelemetry {
  // A runtime without custom spans (an older local workerd) keeps the ledger and log.
  const traces = 'tracing' in workers ? [new TraceSink(workers.tracing, agent)] : []
  return { ...runTelemetry(storage, agent, traces), diagnose: diagnoseExtension(run) }
}
