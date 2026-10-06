/**
 * Public run-telemetry seams for the local benchmark (ADR 0024): the agent's own recorder, ledger and vocabulary, so a
 * benchmark turn is measured exactly as a real one. No services, no deployment.
 */
export { runTelemetry, type RunTelemetryKit } from './run.ts'
export { CollectedRuns, type RunSink } from './events.ts'
export type { RunLedger } from './ledger.ts'
export { summarize } from '../inspect/inspector.ts'
export { RunAttribute, type RunEvent, type RunEventKind, type RunEventStatus } from '@goblin/contracts/telemetry'
