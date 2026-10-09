/** Lane O's files that pass the strict rules (tools/strict/index.ts). Only lane O appends globs here. */
export const paths: string[] = [
  'apps/runtime/src/telemetry/**',
  'apps/runtime/src/inspect/**',
  'apps/runtime/src/inbound/inspection.ts',
  'apps/runtime/src/pi/diagnose.ts',
  'apps/runtime/src/layers/observability.ts',
  // The CLI's main.ts and connect.ts write to the terminal with console, which it is for.
  'apps/cli/src/{args,commands,config,logs,lookup,oauth,render,stats,store}.ts',
  'apps/cli/test/**',
  'apps/runtime/test/{diagnose,inspect,inspect-service,telemetry,telemetry-attention,telemetry-flows,telemetry-ledger,telemetry-recovery,trace}.test.ts',
  'apps/runtime/test/inspection-fixture.ts',
  'apps/runtime/test/mcp/inspection.test.ts',
  'apps/runtime/test/http/api/inspect.test.ts',
  'apps/runtime/test/integration/{auth-inspect,native-telemetry,telemetry-probe}.ts',
]
