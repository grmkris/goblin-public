import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { AgentAppsLive } from '../agent-apps/live.ts'
import type { AppEngine } from '../agent-apps/service.ts'
import { type AppOrigin, AppRegistry, AppsInstance } from '../apps/registry.ts'
import { Apps } from '../apps/service.ts'
import { ChatsInstance } from '../chats/directory.ts'
import { nowSeconds as clockSeconds } from '../clock.ts'
import { ConversationsInstance } from '../conversations.ts'
import { FilesLive } from '../files/live.ts'
import type { Files } from '../files/service.ts'
import { toAppError } from '../http/errors.ts'
import type { KeyedLock } from '../observability/lock.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'

/** A registry call in the service's error channel, mapped as the programs' `attempt` did. */
const step = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: toAppError })
const stepSync = <A>(work: () => A) => Effect.try({ try: work, catch: toAppError })
const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/**
 * Start step 11: the one App registry. Closing a conversation closes its MCP Apps, and an agent app's change (a build,
 * a rollback) updates its App, each written at once. The conversation registry and the apps engine tell of those from
 * synchronous code inside their own Promise work, which cannot run the change bus, so the Apps they changed are told
 * to it right after, through the bridge's `local`.
 */
export const AppRegistryLive: Layer.Layer<
  AppsInstance,
  never,
  AgentInput | Db | ChatsInstance | ConversationsInstance
> = Layer.effect(
  AppsInstance,
  Effect.gen(function* () {
    const { harness, agentApps, local } = yield* AgentInput
    const conversations = yield* ConversationsInstance
    const registry = new AppRegistry(
      yield* Db,
      harness,
      {
        info: (name) => agentApps.info(name),
        launch: (name) => agentApps.launch(name),
        rehome: (closed, to) => agentApps.rehome(closed, to),
      },
      yield* ChatsInstance,
    )
    const told = (ids: readonly string[]) => {
      if (ids.length === 0) return
      local(Changes.use((changes) => changes.publish('apps.changed', { ids }))).catch(() => {
        // expected: the bridge reported the failure; the next change of these Apps tells the feed again.
      })
    }
    conversations.onChange((ids) => told(registry.closeWithConversations(ids, clockSeconds())))
    agentApps.onChange((name) => told(registry.agentChanged(name, clockSeconds())))
    return registry
  }),
)

/** The owner's Apps over `registry`, the agent's one: each write tells the change bus which Apps it changed. */
export const appsOver = (registry: AppRegistry, changes: Changes['Service']) => {
  const changed = (id: string) => changes.publish('apps.changed', { ids: [id] })
  return Apps.of({
    list: stepSync(() => registry.list()).pipe(Effect.withSpan('Apps.list')),
    placement: Effect.fn('Apps.placement')(function* (id: string) {
      return yield* stepSync(() => registry.placement(id))
    }),
    register: Effect.fn('Apps.register')(function* (session: string, callId: string, origin: AppOrigin) {
      const now = yield* nowSeconds
      const app = yield* stepSync(() => registry.register(session, callId, origin, now))
      yield* changed(app.id)
      return app
    }),
    update: Effect.fn('Apps.update')(function* (id: string, closed: boolean) {
      const now = yield* nowSeconds
      const app = yield* stepSync(() => registry.update(id, closed, now))
      yield* changed(app.id)
      return app
    }),
    launch: Effect.fn('Apps.launch')(function* (id: string) {
      return yield* step(() => registry.launch(id))
    }),
    call: Effect.fn('Apps.call')(function* (session: string, callId: string) {
      return yield* step(() => registry.call(session, callId))
    }),
    agentApp: Effect.fn('Apps.agentApp')(function* (id: string) {
      return yield* stepSync(() => registry.agentApp(id))
    }),
    agentId: Effect.fn('Apps.agentId')(function* (name: string) {
      return yield* stepSync(() => registry.agentId(name))
    }),
    removeAgent: Effect.fn('Apps.removeAgent')(function* (name: string) {
      const removed = yield* stepSync(() => registry.removeAgent(name))
      if (removed !== undefined) yield* changes.publish('apps.removed', { id: removed })
    }),
    originOf: Effect.fn('Apps.originOf')(function* (id: string, conversation: string) {
      return yield* stepSync(() => registry.originOf(id, conversation))
    }),
  })
}

/** `Apps` over the agent's one registry (start step 11). */
const AppsServiceLive = Layer.effect(
  Apps,
  Effect.gen(function* () {
    return appsOver(yield* AppsInstance, yield* Changes)
  }),
)

/**
 * Lane A's services after the start: the owner's Apps, the agent's apps and the owner's files. `AppEngine` and `Files`
 * are native over the one engine the agent object made (the engine is connected to the agent's services while this
 * layer is built).
 */
export const AppsLive: Layer.Layer<Apps | AppEngine | Files, never, AgentInput | AppsInstance | Changes | KeyedLock> =
  Layer.mergeAll(AppsServiceLive, AgentAppsLive, FilesLive)
