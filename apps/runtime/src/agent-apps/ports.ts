import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { requirePlan } from '../billing/gates.ts'
import { requireBudget } from '../budget.ts'
import { Setups } from '../setup/service.ts'
import { Channel } from '../channel/service.ts'
import { Forbidden } from '../http/errors.ts'
import type { AgentServices } from '../layers/index.ts'
import { McpConnections, requireResident } from '../mcp/service.ts'
import { bound } from '../runtime/boundary.ts'
import type { Bridge, RunProgram } from '../runtime/bridge.ts'
import { Changes } from '../runtime/changes.ts'
import { appCompletion } from './completion.ts'
import type { AppPorts } from './engine.ts'
import { AppCodeError, appLock, problemText, thrownOf } from './queue.ts'

/** What agent apps reach through their agent (ADR 0021): the owner's MCP tools, the cheap model and Telegram. */
export type AppServices = {
  readonly authorizeCall: (session: string | undefined, app: string) => Promise<void>
  /** One of the owner's MCP tools, called as the agent: the owner's exact grant is checked by the host, live. */
  readonly tool: (request: {
    readonly serverId: string
    readonly name: string
    readonly args: Record<string, unknown>
    readonly session?: string | undefined
  }) => Promise<unknown>
  /** One completion on the deployment's cheap model, counted toward the owner's daily budget. */
  readonly complete: (system: string, prompt: string, maxTokens: number) => Promise<string>
  /** A message to the owner on their Telegram channel; `op` makes a retry send it once. */
  readonly notify: (op: string, text: string) => Promise<void>
  /** Why the agent may not act on its own now (the owner's plan, or resident authority), or undefined if it may. */
  readonly blocked: () => Promise<string | undefined>
}

/** One completion on the cheap model, its tokens recorded against today's budget. */
export type AppCompletion = (
  system: string,
  prompt: string,
  maxTokens: number,
) => Effect.Effect<string, unknown, AgentServices>

/** Telegram's HTML mode reads `<`, `>` and `&`; an app's text is shown as written. */
const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * The services an agent app's powers use, over the agent's own services. Each is a call from the app's isolate, so it
 * enters the runtime through `run`, which checks the owner's plan; then resident authority (and, where a conversation
 * asked, its switches). A lapsed one stops the app's power, never the owner. A power's failure reaches the app as it
 * was thrown.
 */
export function appServices(run: RunProgram, complete: AppCompletion): AppServices {
  const settled = async <A, E>(program: Effect.Effect<A, E, AgentServices>): Promise<A> => {
    const exit = await run(Effect.exit(program))
    if (Exit.isSuccess(exit)) return exit.value
    throw thrownOf(exit.cause)
  }
  return {
    authorizeCall: (session, app) =>
      settled(
        Effect.gen(function* () {
          yield* requireResident
          if (session !== undefined && !(yield* Setups.use((setups) => setups.app(session, app))))
            return yield* new Forbidden({ reason: 'app execution excluded here' })
        }),
      ),
    tool: ({ serverId, name, args, session }) => {
      const authorize = Effect.gen(function* () {
        yield* requireResident
        if (session === undefined) return
        const scope = yield* Setups.use((setups) => setups.scope(session))
        if (!scope.tool(serverId, name)) return yield* new Forbidden({ reason: 'app MCP tool excluded here' })
      })
      return settled(
        Effect.gen(function* () {
          yield* authorize
          // The host checks again right before the call leaves, after the plan as `run` checks it.
          const recheck = yield* bound(Effect.andThen(requirePlan(), authorize))
          return yield* McpConnections.use((connections) =>
            connections.callTool(serverId, name, args, { caller: 'model', timeout: 15_000, authorize: recheck }),
          )
        }),
      )
    },
    complete: (system, prompt, maxTokens) =>
      settled(requireResident.pipe(Effect.andThen(requireBudget), Effect.andThen(complete(system, prompt, maxTokens)))),
    notify: (op, text) =>
      settled(
        Effect.gen(function* () {
          yield* requireResident
          const serverId = (yield* Channel.use((channel) => channel.status))?.serverId
          if (serverId === undefined)
            return yield* Effect.fail(new AppCodeError('notify: the owner has no Telegram channel connected'))
          const recheck = yield* bound(Effect.andThen(requirePlan(), requireResident))
          const result = yield* McpConnections.use((connections) =>
            connections.callTool(
              serverId,
              'send_message',
              { operationId: op, text: escaped(text) },
              { caller: 'model', timeout: 5000, authorize: recheck },
            ),
          )
          if (result.isError === true)
            return yield* Effect.fail(new AppCodeError('notify: the channel refused the message'))
        }),
      ),
    blocked: () =>
      run(requireResident).then(
        () => undefined,
        // expected: a lapsed plan or authority is the answer; the job waits and its status says why
        (cause: unknown) => `waiting for the owner (${problemText(cause)})`,
      ),
  }
}

/**
 * What the agent object lends its apps from its bridge, made once with the engine (agent.ts): the powers' services
 * (each enters the runtime through `run`, which checks the plan), the apps' lock (the runtime's KeyedLock, taken
 * through `local`), and `changed`, which tells the change bus `agent-apps.changed` without waiting for it.
 */
export function appPorts({
  run,
  local,
}: Pick<Bridge, 'run' | 'local'>): Pick<AppPorts, 'services' | 'lock' | 'changed'> {
  return {
    services: appServices(run, appCompletion),
    lock: appLock(local),
    changed: (app) =>
      void local(Changes.use((changes) => changes.publish('agent-apps.changed', { name: app }))).catch(
        // expected: the bridge reported why the runtime is down; the App follows the next change once it is up
        () => undefined,
      ),
  }
}
