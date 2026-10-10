import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type McpHostOptions, mcpHost } from '../../src/mcp/host.ts'
import { makeManager } from '../../src/mcp/manager.ts'
import { McpConnections, McpGrants, McpServers } from '../../src/mcp/service.ts'
import type { McpManagerOptions } from '../../src/mcp/types.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { MemoryCredentials, MemoryGrants, MemoryRegistries } from './memory.ts'
import { servicesOf } from './runtime.ts'

/** A service whose methods answer Promises: each call runs its Effect on the test's runtime. */
export type Promised<S> = {
  readonly [K in keyof S]: S[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E>
    ? (...args: A) => Promise<R>
    : never
}

/** `service`'s methods as Promises run by `run`, for tests written against calls rather than programs. */
export const promised = <S extends object>(
  service: Promise<S>,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
) => {
  const call =
    (key: string | symbol) =>
    async (...args: unknown[]): Promise<unknown> => {
      const target = await service
      // SAFETY: a test reads only the service's own method names, each an Effect-returning function of its arguments.
      const method = target[key as keyof S] as (...given: unknown[]) => Effect.Effect<unknown, unknown>
      return run(method(...args))
    }
  // SAFETY: every property of the proxy is `call` of the service's method of the same name.
  return new Proxy({}, { get: (_target, key) => call(key) }) as Promised<S>
}

/** A connection manager over `options`, made as the host makes it; `dispose` ends it and closes its connections. */
export const managerOf = (options: McpManagerOptions) => {
  const { run, dispose } = servicesOf(
    Layer.effect(McpConnections, Effect.orDie(makeManager(options))).pipe(Layer.provide(SingleFlight.layer)),
  )
  return { connections: promised(run(McpConnections), run), run, dispose }
}

/** The MCP host's services over `options`, with memory stores where a test gives none. */
export const hostOf = (
  options: Pick<McpHostOptions, 'servers' | 'fetch'> & Partial<Omit<McpHostOptions, 'servers' | 'fetch'>>,
) => {
  const host = mcpHost({
    credentials: new MemoryCredentials(),
    grants: new MemoryGrants(),
    registries: new MemoryRegistries(),
    appUrl: 'https://goblin.test',
    ...options,
  })
  const { run, dispose } = servicesOf(host.pipe(Layer.provideMerge(SingleFlight.layer)))
  return {
    run,
    dispose,
    connections: promised(run(McpConnections), run),
    servers: promised(run(McpServers), run),
    grants: promised(run(McpGrants), run),
  }
}
