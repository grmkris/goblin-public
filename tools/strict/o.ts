/** Lane O's files that pass the strict rules (tools/strict/index.ts). Only lane O appends globs here. */
export const paths: string[] = [
  // telemetry/log.ts writes its run lines with console until the logger knows a `run` event.
  'apps/runtime/src/telemetry/{agent,attention,attributes,benchmark,events,ledger,pi-records,pi,rehydrate,report,run,safety,trace}.ts',
  'apps/runtime/src/inspect/**',
  'apps/runtime/src/inbound/inspection.ts',
  'apps/runtime/src/pi/diagnose.ts',
  'apps/runtime/src/layers/observability.ts',
  // The CLI's main.ts and connect.ts write to the terminal with console, which it is for.
  'apps/cli/src/{args,commands,config,logs,oauth,render,store}.ts',
  'apps/cli/test/**',
  'apps/runtime/test/{inspect,inspect-service,telemetry,telemetry-attention,telemetry-flows,telemetry-ledger,telemetry-recovery,trace}.test.ts',
  'apps/runtime/test/mcp/inspection.test.ts',
  'apps/runtime/test/http/api/inspect.test.ts',
  'apps/runtime/test/integration/telemetry-probe.ts',
]
