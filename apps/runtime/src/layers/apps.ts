import type { AgentAppChange } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { appDetail, appSummaries, changeApp } from '../agent-apps/manage.ts'
import { AppEngine } from '../agent-apps/service.ts'
import type { AppOrigin } from '../apps/registry.ts'
import { Apps } from '../apps/service.ts'
import { nowMillis } from '../clock.ts'
import type { FileCaller } from '../files/store.ts'
import { Files } from '../files/service.ts'
import { AppEngine as LegacyEngine, Apps as LegacyApps, Files as LegacyFiles } from '../services.ts'
import { attempt, attemptSync, nowSecondsEffect } from '../services.ts'
import type { FoundationServices } from './core.ts'

/** A change to an agent app other than moving its home, which the program checks first. */
type OwnerChange = Exclude<AgentAppChange, { readonly kind: 'home' }>

/**
 * `Apps` over the App registry the legacy start made: the same instance, each call wrapped as the programs wrapped it,
 * so a thrown failure arrives as its `AppError`.
 */
const AppsAdapter = Layer.effect(
  Apps,
  Effect.gen(function* () {
    const registry = yield* LegacyApps
    return Apps.of({
      list: Effect.fn('Apps.list')(function* () {
        return yield* attemptSync(() => registry.list())
      }),
      placement: Effect.fn('Apps.placement')(function* (id: string) {
        return yield* attemptSync(() => registry.placement(id))
      }),
      register: Effect.fn('Apps.register')(function* (session: string, callId: string, origin: AppOrigin) {
        const now = yield* nowSecondsEffect
        return yield* attemptSync(() => registry.register(session, callId, origin, now))
      }),
      update: Effect.fn('Apps.update')(function* (id: string, closed: boolean) {
        const now = yield* nowSecondsEffect
        return yield* attemptSync(() => registry.update(id, closed, now))
      }),
      launch: Effect.fn('Apps.launch')(function* (id: string) {
        return yield* attempt(() => registry.launch(id))
      }),
      call: Effect.fn('Apps.call')(function* (session: string, callId: string) {
        return yield* attempt(() => registry.call(session, callId))
      }),
      agentApp: Effect.fn('Apps.agentApp')(function* (id: string) {
        return yield* attemptSync(() => registry.agentApp(id))
      }),
      agentId: Effect.fn('Apps.agentId')(function* (name: string) {
        return yield* attemptSync(() => registry.agentId(name))
      }),
      removeAgent: Effect.fn('Apps.removeAgent')(function* (name: string) {
        return yield* attemptSync(() => registry.removeAgent(name))
      }),
      originOf: Effect.fn('Apps.originOf')(function* (id: string, conversation: string) {
        return yield* attemptSync(() => registry.originOf(id, conversation))
      }),
    })
  }),
)

/** `AppEngine` over the agent object's own apps engine (one instance, made before Pi opened), wrapped the same way. */
const AppEngineAdapter = Layer.effect(
  AppEngine,
  Effect.gen(function* () {
    const engine = yield* LegacyEngine
    return AppEngine.of({
      info: Effect.fn('AppEngine.info')(function* (name: string) {
        return yield* attemptSync(() => engine.info(name))
      }),
      summaries: Effect.fn('AppEngine.summaries')(function* () {
        return yield* attemptSync(() => appSummaries(engine))
      }),
      detail: Effect.fn('AppEngine.detail')(function* (name: string) {
        return yield* attempt(() => appDetail(engine, name, nowMillis()))
      }),
      change: Effect.fn('AppEngine.change')(function* (name: string, change: OwnerChange) {
        return yield* attempt(() => changeApp(engine, name, change))
      }),
      moveHome: Effect.fn('AppEngine.moveHome')(function* (name: string, session: string) {
        return yield* attemptSync(() => engine.moveHome(name, session))
      }),
      remove: Effect.fn('AppEngine.remove')(function* (name: string) {
        return yield* attempt(() => engine.remove(name))
      }),
      snapshot: Effect.fn('AppEngine.snapshot')(function* (name: string) {
        return yield* attemptSync(() => engine.snapshot(name))
      }),
      launch: Effect.fn('AppEngine.launch')(function* (name: string) {
        return yield* attemptSync(() => engine.launch(name))
      }),
      viewCall: Effect.fn('AppEngine.viewCall')(function* (name: string, member: string, input: unknown, op: string) {
        return yield* attempt(() => engine.viewCall(name, member, input, op))
      }),
      viewError: Effect.fn('AppEngine.viewError')(function* (name: string, message: string) {
        return yield* attemptSync(() => engine.viewError(name, message))
      }),
    })
  }),
)

/** `Files` over the owner's file store, wrapped the same way. */
const FilesAdapter = Layer.effect(
  Files,
  Effect.gen(function* () {
    const store = yield* LegacyFiles
    return Files.of({
      list: Effect.fn('Files.list')(function* (dir: string) {
        return yield* attempt(() => store.list(dir))
      }),
      stat: Effect.fn('Files.stat')(function* (path: string) {
        return yield* attempt(() => store.stat(path))
      }),
      read: Effect.fn('Files.read')(function* (path: string) {
        return yield* attempt(() => store.read(path))
      }),
      text: Effect.fn('Files.text')(function* (path: string, offset: number, maxBytes: number) {
        return yield* attempt(() => store.text(path, offset, maxBytes))
      }),
      write: Effect.fn('Files.write')(function* (
        caller: FileCaller,
        path: string,
        body: string | Uint8Array | ReadableStream<Uint8Array>,
        mimeType: string,
        size: number,
      ) {
        return yield* attempt(() => store.write(caller, path, body, mimeType, size))
      }),
      remove: Effect.fn('Files.remove')(function* (caller: FileCaller, path: string) {
        return yield* attempt(() => store.remove(caller, path))
      }),
    })
  }),
)

/**
 * Lane A's services: the owner's Apps, the agent's apps and the owner's files. Until wave 3 each adapts the instance
 * the legacy start made (layers/legacy.ts), so there is still one of each.
 */
export const AppsLive: Layer.Layer<Apps | AppEngine | Files, never, FoundationServices> = Layer.mergeAll(
  AppsAdapter,
  AppEngineAdapter,
  FilesAdapter,
)
