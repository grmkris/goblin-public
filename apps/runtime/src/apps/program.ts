import type {
  AgentAppChange,
  AgentAppDetail,
  AppCall,
  AppDiagnostic,
  CreateApp,
  DeleteAgentApp,
  UpdateApp,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import { appDetail, appSummaries, changeApp } from '../agent-apps/manage.ts'
import { nowMillis } from '../clock.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { toolAppResource } from '../mcp/connection.ts'
import { AppEngine, Apps, Conversations, Home, Mcp, attempt, attemptSync, nowSecondsEffect } from '../services.ts'

/**
 * Keep the App of a call in one of the owner's conversations, read from its transcript: a call made before Apps were
 * kept, or shown again after it was closed. Its tool must still render that App.
 */
export const createOwnerApp = ({ conversation, callId }: CreateApp) =>
  Effect.gen(function* () {
    const session = yield* Conversations.use((conversations) => attemptSync(() => conversations.require(conversation)))
    const apps = yield* Apps
    const call = yield* attempt(() => apps.call(session, callId))
    const mcp = yield* Mcp
    const snapshot = yield* attempt(() => mcp.manager.connect(call.serverId))
    const tool = snapshot.tools.find(({ name }) => name === call.tool)
    const uri = tool === undefined ? undefined : toolAppResource(tool)
    if (uri === undefined) return yield* new NotFound({ what: 'app' })
    const origin = { serverId: call.serverId, tool: call.tool, uri, title: tool?.title ?? call.tool }
    return apps.register(session, callId, origin, yield* nowSecondsEffect)
  })

/** Close an App, or open it again. */
export const updateOwnerApp = (id: string, change: UpdateApp) =>
  Effect.gen(function* () {
    const apps = yield* Apps
    const now = yield* nowSecondsEffect
    return yield* attemptSync(() => apps.update(id, change.closed, now))
  })

/** What the browser needs to load an App; it grants nothing (its calls are checked live). */
export const launchOwnerApp = (id: string) => Apps.use((apps) => attempt(() => apps.launch(id)))

/** The agent app an App id names, with the engine that runs it. */
const agentApp = (id: string) =>
  Effect.gen(function* () {
    const apps = yield* Apps
    const name = yield* attemptSync(() => apps.agentApp(id))
    return { name, engine: yield* AppEngine }
  })

/** An agent app's state now, for its view (ADR 0021). */
export const agentAppSnapshot = (id: string) =>
  Effect.flatMap(agentApp(id), ({ name, engine }) => attemptSync(() => engine.snapshot(name)))

/** An action an agent app's view calls, as the owner: the state after it, or the app's own error. */
export const callAgentApp = (id: string, call: AppCall) =>
  Effect.flatMap(agentApp(id), ({ name, engine }) =>
    attempt(() => engine.viewCall(name, call.name, call.arguments, call.op)),
  )

/** A failure an agent app's view reported, kept where the agent sees it. */
export const reportAgentApp = (id: string, diagnostic: AppDiagnostic) =>
  Effect.flatMap(agentApp(id), ({ name, engine }) => attemptSync(() => engine.viewError(name, diagnostic.message)))

/** The owner's agent apps, newest change first, each with its App id once it has a view (ADR 0021). */
export const agentAppList = Effect.gen(function* () {
  const engine = yield* AppEngine
  const apps = yield* Apps
  return yield* attemptSync(() => appSummaries(engine).map((app) => ({ ...app, app: apps.agentId(app.name) })))
})

/** One agent app in full. */
export const agentAppDetail = (name: string): Effect.Effect<AgentAppDetail, AppError, AppEngine | Apps> =>
  Effect.gen(function* () {
    const engine = yield* AppEngine
    const apps = yield* Apps
    const detail = yield* attempt(() => appDetail(engine, name, nowMillis()))
    return { ...detail, app: apps.agentId(name) }
  })

/**
 * A change the owner makes to an agent app, answered with the app as it is after it. A new home must be an open
 * conversation of the owner's own (main or a thread).
 */
export const changeAgentApp = (name: string, change: AgentAppChange) =>
  Effect.gen(function* () {
    const engine = yield* AppEngine
    if (change.kind === 'home') {
      const session = yield* Conversations.use((conversations) =>
        attemptSync(() => {
          const open = conversations.requireOpen(change.conversation)
          if (conversations.kindOf(change.conversation) === 'subagent')
            throw new InvalidInput({ reason: "an app's home is main or a thread" })
          return open
        }),
      )
      yield* attemptSync(() => engine.moveHome(name, session))
    } else yield* attempt(() => changeApp(engine, name, change))
    return yield* agentAppDetail(name)
  })

/** The owner deletes an agent app, confirmed by its name: its tools, schedules, files and data go, and its App. */
export const deleteAgentApp = (name: string, input: DeleteAgentApp) =>
  Effect.gen(function* () {
    if (input.confirm !== name) return yield* new InvalidInput({ reason: `type ${name} to delete it` })
    const engine = yield* AppEngine
    yield* attempt(() => engine.remove(name))
    yield* Apps.use((apps) => attemptSync(() => apps.removeAgent(name)))
    yield* Home.use((home) => attemptSync(() => home.appRemoved()))
    return { deleted: name }
  })
