/** Lane D's files that pass the strict rules (tools/strict/index.ts). Only lane D appends globs here. */
export const paths: string[] = [
  'apps/runtime/src/topics/**',
  'apps/runtime/src/organize/**',
  'apps/runtime/src/workspace/**',
  'apps/runtime/src/home/**',
  // personas/ask.ts is lane C's.
  'apps/runtime/src/personas/api.ts',
  'apps/runtime/src/personas/invocations.ts',
  'apps/runtime/src/personas/program.ts',
  'apps/runtime/src/personas/registry.ts',
  'apps/runtime/src/personas/routes.ts',
  'apps/runtime/src/pi/subagents.ts',
  'apps/runtime/src/pi/subagent-relay.ts',
  'apps/runtime/src/pi/persona-turn.ts',
  'apps/runtime/src/pi/persona.ts',
  'apps/runtime/src/pi/thread.ts',
  'apps/runtime/src/pi/organize.ts',
  'apps/runtime/src/pi/home.ts',
  'apps/runtime/src/pi/helper-execution.ts',
  'apps/runtime/src/storage/personas.ts',
  'apps/runtime/src/storage/topics.ts',
  'apps/runtime/src/storage/home-schema.ts',
]
