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
    name: '@goblin/bench',
    role: 'bounded native memory benchmark and experiment workspace',
    runtime: 'tooling',
    mayImport: ['@goblin/runtime'],
    zones: { test: 'test', worker: 'cloud' },
    seam: { consumer: 'developers and CI', reason: 'benchmark runner is intentionally outside deployed applications' },
  },
  {
    dir: 'apps/cli',
    name: '@goblin/cli',
    role: "the goblin terminal client: an MCP client of the Worker's /mcp with inspection, and Workers Logs",
    runtime: 'daemon',
    mayImport: ['@goblin/contracts'],
  },
  {
    dir: 'apps/runtime',
    name: '@goblin/runtime',
    role: 'resident Cloudflare Agent and authorized MCP host',
    runtime: 'cloud',
    mayImport: ['@goblin/app', '@goblin/contracts'],
  },
  {
    dir: 'apps/web',
    name: '@goblin/web',
    role: 'TanStack Start web projection and sandboxed MCP Apps host',
    runtime: 'browser',
    mayImport: ['@goblin/app', '@goblin/contracts', '@goblin/kit', '@goblin/ui', '@goblin/runtime'],
    zones: { 'src/worker.ts': 'cloud' },
  },
  {
    dir: 'packages/contracts',
    name: '@goblin/contracts',
    role: 'runtime-independent cross-runtime schemas and contracts',
    runtime: 'shared',
    mayImport: [],
  },
  {
    dir: 'packages/app',
    name: '@goblin/app',
    role: 'agent app SDK and toolchain, run inside Dynamic Workers, and the frame runtime of app views',
    runtime: 'cloud',
    mayImport: ['@goblin/kit', '@goblin/ui'],
    zones: { 'src/ui': 'browser' },
  },
  {
    dir: 'packages/kit',
    name: '@goblin/kit',
    role: 'drawn blocks (diagrams, charts, maps) shared by the chat and agent apps',
    runtime: 'browser',
    mayImport: [],
  },
  {
    dir: 'packages/ui',
    name: '@goblin/ui',
    role: 'shared editable shadcn browser components',
    runtime: 'browser',
    mayImport: [],
  },
  {
    dir: 'tools',
    name: '@goblin/tools',
    role: 'repository quality checks and AST plugins',
    runtime: 'tooling',
    mayImport: [],
    seam: { consumer: 'root scripts and CI', reason: 'quality tooling has no deployed app consumer' },
  },
]
