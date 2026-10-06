import type { Extension } from '@earendil-works/pi-durable'
import { diagnoseExtension } from '../pi/diagnose.ts'
import type { RunProgram } from '../pi/resident-mcp.ts'
import { type RunTelemetryKit, runTelemetry } from './run.ts'

/** The agent's telemetry and its own read-only `diagnose` tool over the ledger, for main. */
export type AgentTelemetry = RunTelemetryKit & { readonly diagnose: Extension }

export function agentTelemetry(storage: DurableObjectStorage, agent: () => string, run: RunProgram): AgentTelemetry {
  return { ...runTelemetry(storage, agent), diagnose: diagnoseExtension(run) }
}
