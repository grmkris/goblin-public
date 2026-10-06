// The part of `cloudflare:workers` the render check uses. Its tsconfig has the browser's types for goblin's
// components, which clash with @cloudflare/workers-types, so it declares this one class itself.
declare module 'cloudflare:workers' {
  export abstract class WorkerEntrypoint {
    protected readonly ctx: unknown
    protected readonly env: unknown
  }
}
