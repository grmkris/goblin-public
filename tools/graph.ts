/** Runtime and workspace ownership, adapted from the pinned MyApps graph. */
export type Runtime = 'cloud' | 'shared' | 'browser' | 'daemon' | 'test' | 'tooling'
/** A module of a workspace that only the files listed may import (paths relative to the workspace). */
export interface Closed {
  /** The files that may import it; a path ending in `/` is every file under that directory. */
  readonly importers: readonly string[]
  /** Only these of its exports are closed; without it, the whole module is. */
  readonly names?: readonly string[]
  readonly reason: string
}
export interface Node {
  readonly dir: string
  readonly name: string
  readonly role: string
  readonly runtime: Runtime
  readonly mayImport: readonly string[]
  readonly zones?: Readonly<Record<string, Runtime>>
  /** Entries of an importable workspace that this one must still never import, each with the reason. */
  readonly forbids?: Readonly<Record<string, string>>
  /** Modules of this workspace closed to all but the files they list (`boundaries/no-closed-import`). */
  readonly closed?: Readonly<Record<string, Closed>>
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
    closed: {
      // The ways into Effect (docs/agents/effect.md): a program composes and never runs one.
      'src/runtime/bridge.ts': {
        importers: [
          'src/agent.ts',
          'src/agent-apps/ports.ts',
          'src/channel/wake.ts',
          'src/organize/kit.ts',
          'src/pi/apps.ts',
          'src/pi/budget.ts',
          'src/pi/decisions.ts',
          'src/pi/diagnose.ts',
          'src/pi/files.ts',
          'src/pi/home.ts',
          'src/pi/memory.ts',
          'src/pi/onboarding.ts',
          'src/pi/organize.ts',
          'src/pi/persona-turn.ts',
          'src/pi/resident-mcp.ts',
          'src/pi/retrieval.ts',
          'src/pi/routine-budget.ts',
          'src/pi/routine-run.ts',
          'src/pi/routines.ts',
          'src/pi/servers.ts',
          'src/pi/skills.ts',
          'src/pi/subagent-relay.ts',
          'src/pi/subagents.ts',
          'src/pi/thread.ts',
          'src/routines/kit.ts',
          'src/routines/wake.ts',
          'src/telemetry/agent.ts',
          'test/',
        ],
        reason:
          'the bridge runs programs for code outside the runtime: agent.ts, and the kits, alarms and apps engine it hands the bridge to',
      },
      'src/runtime/boundary.ts': {
        names: ['promiseWith'],
        importers: ['src/mcp/auth.ts', 'src/mcp/dispatch.ts', 'src/workspace/live.ts', 'test/'],
        reason:
          "promiseWith answers a foreign Promise callback wired inside a layer: the MCP SDK's auth provider and dispatch guards, and Pi's task graph watch",
      },
    },
  },
  {
    dir: 'apps/web',
    name: '@goblin/web',
    role: 'TanStack Start web projection and sandboxed MCP Apps host',
    runtime: 'browser',
    mayImport: ['@goblin/app', '@goblin/contracts', '@goblin/kit', '@goblin/ui', '@goblin/runtime'],
    zones: { 'src/worker.ts': 'cloud' },
    forbids: {
      '@goblin/contracts/internal': 'it is the Worker-to-agent API, and nothing in the web app ever calls /internal',
    },
  },
  {
    dir: 'apps/wallet',
    name: '@goblin/wallet-worker',
    role: 'Goblin Wallet Worker: owner API, inbound MCP, OAuth and the per-owner ledger Durable Object',
    runtime: 'cloud',
    mayImport: ['@goblin/wallet'],
  },
  {
    dir: 'apps/wallet-web',
    name: '@goblin/wallet-web',
    role: 'Goblin Wallet owner console and MCP App views, built as static assets',
    runtime: 'browser',
    mayImport: ['@goblin/ui', '@goblin/wallet'],
    forbids: Object.fromEntries(
      ['privy', 'signer', 'relay', 'x402', 'tempo', 'lifi', 'bridge'].map((module) => [
        `@goblin/wallet/${module}`,
        'server signing and Privy app credentials never enter the browser bundle',
      ]),
    ),
  },
  {
    dir: 'packages/contracts',
    name: '@goblin/contracts',
    role: 'runtime-independent cross-runtime schemas and contracts',
    runtime: 'shared',
    mayImport: [],
  },
  {
    dir: 'packages/wallet',
    name: '@goblin/wallet',
    role: 'runtime-independent Goblin Wallet library: chains, amounts, contract and rails',
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
