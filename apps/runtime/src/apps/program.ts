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
import { AppEngine } from '../agent-apps/service.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { toolAppResource } from '../mcp/connection.ts'
import { Conversations, Home, Mcp, attempt, attemptSync } from '../services.ts'
import { Apps } from './service.ts'

/**
 * Keep the App of a call in one of the owner's conversations, read from its transcript: a call made before Apps were
 * kept, or shown again after it was closed. Its tool must still render that App.
 */
export const createOwnerApp = ({ conversation, callId }: CreateApp) =>
  Effect.gen(function* () {
    const session = yield* Conversations.use((conversations) => attemptSync(() => conversations.require(conversation)))
    const apps = yield* Apps
    const call = yield* apps.call(session, callId)
    const mcp = yield* Mcp
    const snapshot = yield* attempt(() => mcp.manager.connect(call.serverId))
    const tool = snapshot.tools.find(({ name }) => name === call.tool)
    const uri = tool === undefined ? undefined : toolAppResource(tool)
    if (uri === undefined) return yield* new NotFound({ what: 'app' })
    const origin = { serverId: call.serverId, tool: call.tool, uri, title: tool?.title ?? call.tool }
    return yield* apps.register(session, callId, origin)
  })

/** Close an App, or open it again. */
export const updateOwnerApp = (id: string, change: UpdateApp) => Apps.use((apps) => apps.update(id, change.closed))

/** What the browser needs to load an App; it grants nothing (its calls are checked live). */
export const launchOwnerApp = (id: string) => Apps.use((apps) => apps.launch(id))

/** The agent app an App id names, with the engine that runs it. */
const agentApp = (id: string) =>
  Effect.gen(function* () {
    const name = yield* Apps.use((apps) => apps.agentApp(id))
    return { name, engine: yield* AppEngine }
  })

/** An agent app's state now, for its view (ADR 0021). */
export const agentAppSnapshot = (id: string) =>
  Effect.flatMap(agentApp(id), ({ name, engine }) => engine.snapshot(name))

/** An action an agent app's view calls, as the owner: the state after it, or the app's own error. */
export const callAgentApp = (id: string, call: AppCall) =>
  Effect.flatMap(agentApp(id), ({ name, engine }) => engine.viewCall(name, call.name, call.arguments, call.op))

/** A failure an agent app's view reported, kept where the agent sees it. */
export const reportAgentApp = (id: string, diagnostic: AppDiagnostic) =>
  Effect.flatMap(agentApp(id), ({ name, engine }) => engine.viewError(name, diagnostic.message))

/** The owner's agent apps, newest change first, each with its App id once it has a view (ADR 0021). */
export const agentAppList = Effect.gen(function* () {
  const summaries = yield* AppEngine.use((engine) => engine.summaries)
  const apps = yield* Apps
  return yield* Effect.forEach(summaries, (app) => Effect.map(apps.agentId(app.name), (id) => ({ ...app, app: id })))
})

/** One agent app in full. */
export const agentAppDetail = (name: string): Effect.Effect<AgentAppDetail, AppError, AppEngine | Apps> =>
  Effect.gen(function* () {
    const detail = yield* AppEngine.use((engine) => engine.detail(name))
    return { ...detail, app: yield* Apps.use((apps) => apps.agentId(name)) }
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
          conversations.requireOpen(change.conversation)
          if (conversations.kindOf(change.conversation) === 'subagent')
            throw new InvalidInput({ reason: "an app's home is main or a thread" })
          return change.conversation
        }),
      )
      yield* engine.moveHome(name, session)
    } else yield* engine.change(name, change)
    return yield* agentAppDetail(name)
  })

/** The owner deletes an agent app, confirmed by its name: its schedules, files and data go, and its App. */
export const deleteAgentApp = (name: string, input: DeleteAgentApp) =>
  Effect.gen(function* () {
    if (input.confirm !== name) return yield* new InvalidInput({ reason: `type ${name} to delete it` })
    yield* AppEngine.use((engine) => engine.remove(name))
    yield* Apps.use((apps) => apps.removeAgent(name))
    yield* Home.use((home) => attemptSync(() => home.appRemoved()))
    return { deleted: name }
  })
