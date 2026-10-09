import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { AgentAppsLive } from '../agent-apps/live.ts'
import type { AppEngine } from '../agent-apps/service.ts'
import type { AppOrigin } from '../apps/registry.ts'
import { Apps } from '../apps/service.ts'
import { FilesLive } from '../files/live.ts'
import type { Files } from '../files/service.ts'
import { toAppError } from '../http/errors.ts'
import { Apps as LegacyApps } from '../services.ts'
import type { FoundationServices } from './core.ts'

/** A registry call in the service's error channel, mapped as the programs' `attempt` did. */
const step = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: toAppError })
const stepSync = <A>(work: () => A) => Effect.try({ try: work, catch: toAppError })
const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/**
 * `Apps` over the App registry the legacy start made: the same instance, each call wrapped as the programs wrapped it,
 * so a thrown failure arrives as its `AppError`.
 */
const AppsAdapter = Layer.effect(
  Apps,
  Effect.gen(function* () {
    const registry = yield* LegacyApps
    return Apps.of({
      list: stepSync(() => registry.list()).pipe(Effect.withSpan('Apps.list')),
      placement: Effect.fn('Apps.placement')(function* (id: string) {
        return yield* stepSync(() => registry.placement(id))
      }),
      register: Effect.fn('Apps.register')(function* (session: string, callId: string, origin: AppOrigin) {
        const now = yield* nowSeconds
        return yield* stepSync(() => registry.register(session, callId, origin, now))
      }),
      update: Effect.fn('Apps.update')(function* (id: string, closed: boolean) {
        const now = yield* nowSeconds
        return yield* stepSync(() => registry.update(id, closed, now))
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
        return yield* stepSync(() => registry.removeAgent(name))
      }),
      originOf: Effect.fn('Apps.originOf')(function* (id: string, conversation: string) {
        return yield* stepSync(() => registry.originOf(id, conversation))
      }),
    })
  }),
)

/**
 * Lane A's services: the owner's Apps, the agent's apps and the owner's files. `AppEngine` and `Files` are native over
 * the one engine the agent object made (the engine is connected to the agent's services while this layer is built);
 * `Apps` still adapts the registry the legacy start made, whose listeners the workspace feed and Home hold, until
 * those listeners move to `Changes`.
 */
export const AppsLive: Layer.Layer<Apps | AppEngine | Files, never, FoundationServices> = Layer.mergeAll(
  AppsAdapter,
  AgentAppsLive,
  FilesLive,
)
