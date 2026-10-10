import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { AgentAppsLive } from '../agent-apps/live.ts'
import type { AppEngine } from '../agent-apps/service.ts'
import {
  type AppOrigin,
  type AppSources,
  agentAppChanged,
  agentAppId,
  agentAppName,
  appList,
  appOrigin,
  appPlacement,
  appView,
  closeWithConversations,
  findCall,
  keepApp,
  keepCallEntry,
  launchSite,
  removeAgentApp,
  setAppClosed,
} from '../apps/registry.ts'
import { Apps } from '../apps/service.ts'
import { ChatsInstance } from '../chats/directory.ts'
import { epochSeconds } from '../clock.ts'
import { FilesLive } from '../files/live.ts'
import type { Files } from '../files/service.ts'
import { attemptSync } from '../http/errors.ts'
import type { KeyedLock } from '../observability/lock.ts'
import { PiSessions } from '../pi/sessions.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'

/** The owner's Apps over the agent's database: each write tells the change bus which Apps it changed. */
export const appsOver = (
  db: Db['Service'],
  sources: AppSources,
  changes: Changes['Service'],
  sessions: PiSessions['Service'],
) => {
  const { agents } = sources
  const changed = (id: string) => changes.publish('apps.changed', { ids: [id] })
  return Apps.of({
    list: attemptSync(() => appList(db, agents)).pipe(Effect.withSpan('Apps.list')),
    view: Effect.fn('Apps.view')(function* (id: string) {
      return yield* attemptSync(() => appView(db, agents, id))
    }),
    placement: Effect.fn('Apps.placement')(function* (id: string) {
      return yield* attemptSync(() => appPlacement(db, id))
    }),
    register: Effect.fn('Apps.register')(function* (session: string, callId: string, origin: AppOrigin) {
      const now = yield* epochSeconds
      const app = yield* attemptSync(() => keepApp(db, sources, { session, callId, origin }, now))
      yield* changed(app.id)
      return app
    }),
    update: Effect.fn('Apps.update')(function* (id: string, closed: boolean) {
      const now = yield* epochSeconds
      const app = yield* attemptSync(() => setAppClosed(db, agents, id, closed, now))
      yield* changed(app.id)
      return app
    }),
    launch: Effect.fn('Apps.launch')(function* (id: string) {
      const site = yield* attemptSync(() => launchSite(db, id))
      if (site.kind === 'agent') return yield* attemptSync(() => agents.launch(site.name))
      const call = yield* findCall(sessions, site.session, site.callId, site.entry)
      if (site.entry === undefined) yield* attemptSync(() => keepCallEntry(db, id, call.entry))
      return {
        kind: 'mcp' as const,
        serverId: site.serverId,
        uri: site.uri,
        arguments: call.arguments,
        result: call.result,
      }
    }),
    call: Effect.fn('Apps.call')(function* (session: string, callId: string) {
      return yield* findCall(sessions, session, callId)
    }),
    agentApp: Effect.fn('Apps.agentApp')(function* (id: string) {
      return yield* attemptSync(() => agentAppName(db, id))
    }),
    agentId: Effect.fn('Apps.agentId')(function* (name: string) {
      return yield* attemptSync(() => agentAppId(db, name))
    }),
    removeAgent: Effect.fn('Apps.removeAgent')(function* (name: string) {
      const removed = yield* attemptSync(() => removeAgentApp(db, name))
      if (removed !== undefined) yield* changes.publish('apps.removed', { id: removed })
    }),
    originOf: Effect.fn('Apps.originOf')(function* (id: string, conversation: string) {
      return yield* attemptSync(() => appOrigin(db, id, conversation))
    }),
  })
}

/**
 * Start step 11: the owner's Apps, over the agent's database. Closing a conversation (`conversations.changed`) closes
 * its MCP Apps, and an agent app's change (`agent-apps.changed`: a build, a rollback, a new revision) updates its App,
 * each written at once and told to the change bus.
 */
export const AppRegistryLive: Layer.Layer<Apps, never, AgentInput | Db | ChatsInstance | Changes | PiSessions> =
  Layer.effect(
    Apps,
    Effect.gen(function* () {
      const { agentApps } = yield* AgentInput
      const db = yield* Db
      const changes = yield* Changes
      const sources: AppSources = {
        agents: {
          info: (name) => agentApps.info(name),
          launch: (name) => agentApps.launch(name),
          rehome: (closed, to) => agentApps.rehome(closed, to),
        },
        chats: yield* ChatsInstance,
      }
      const told = (ids: readonly string[]) =>
        ids.length === 0 ? Effect.void : changes.publish('apps.changed', { ids })
      yield* changes.on('conversations.changed', ({ ids }) =>
        Effect.flatMap(epochSeconds, (now) => told(closeWithConversations(db, sources, ids, now))),
      )
      yield* changes.on('agent-apps.changed', ({ name }) =>
        Effect.flatMap(epochSeconds, (now) => told(agentAppChanged(db, sources, name, now))),
      )
      return appsOver(db, sources, changes, yield* PiSessions)
    }),
  )

/** The agent's apps and the owner's files after the start, native over the one engine the agent object made. */
export const AppsLive: Layer.Layer<AppEngine | Files, never, AgentInput | KeyedLock> = Layer.mergeAll(
  AgentAppsLive,
  FilesLive,
)
