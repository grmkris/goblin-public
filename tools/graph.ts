/** Runtime and workspace ownership, adapted from the pinned MyApps graph. */
export type Runtime = 'cloud' | 'shared' | 'browser' | 'daemon' | 'test' | 'tooling'
export interface Node {
  readonly dir: string
  readonly name: string
  readonly role: string
  readonly runtime: Runtime
  readonly mayImport: readonly string[]
  readonly zones?: Readonly<Record<string, Runtime>>
  readonly seam?: { readonly consumer: string; readonly reason: string }
}
export const zones: Readonly<Record<string, Runtime>> = {
  scripts: 'tooling',
  deploy: 'tooling',
  drizzle: 'tooling',
  test: 'test',
  tests: 'test',
  fixtures: 'test',
}
export const runtimeModules = {
  bun: ['bun', 'bun:', '@effect/platform-bun'],
  cloudflare: ['cloudflare:'],
  node: ['node:'],
} as const
export const runtimeAllows: Readonly<Record<Runtime, readonly (keyof typeof runtimeModules)[]>> = {
  cloud: ['cloudflare', 'node'],
  shared: [],
  browser: [],
  daemon: ['bun', 'node'],
  test: ['cloudflare', 'node'],
  tooling: ['bun', 'cloudflare', 'node'],
}
export const nodes: readonly Node[] = [
  {
    dir: 'bench',
    name: '@purrable/bench',
    role: 'bounded native memory benchmark and experiment workspace',
    runtime: 'tooling',
    mayImport: ['@purrable/runtime'],
    zones: { test: 'test', worker: 'cloud' },
    seam: { consumer: 'developers and CI', reason: 'benchmark runner is intentionally outside deployed applications' },
  },
  {
    dir: 'apps/runtime',
    name: '@purrable/runtime',
    role: 'resident Cloudflare Agent and authorized MCP host',
    runtime: 'cloud',
    mayImport: ['@purrable/contracts'],
  },
  {
    dir: 'apps/web',
    name: '@purrable/web',
    role: 'TanStack Start web projection and sandboxed MCP Apps host',
    runtime: 'browser',
    mayImport: ['@purrable/contracts', '@purrable/ui', '@purrable/runtime'],
    zones: { 'src/worker.ts': 'cloud' },
  },
  {
    dir: 'packages/contracts',
    name: '@purrable/contracts',
    role: 'runtime-independent cross-runtime schemas and contracts',
    runtime: 'shared',
    mayImport: [],
  },
  {
    dir: 'packages/ui',
    name: '@purrable/ui',
    role: 'shared editable shadcn browser components',
    runtime: 'browser',
    mayImport: [],
  },
  {
    dir: 'tools',
    name: '@purrable/tools',
    role: 'repository quality checks and AST plugins',
    runtime: 'tooling',
    mayImport: [],
    seam: { consumer: 'root scripts and CI', reason: 'quality tooling has no deployed app consumer' },
  },
]
