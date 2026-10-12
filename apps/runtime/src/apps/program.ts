import type {
  AgentAppChange,
  AgentAppDetail,
  AppCall,
  AppDiagnostic,
  CreateApp,
  DeleteAgentApp,
  OpenServerApp,
  UpdateApp,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import { AppEngine } from '../agent-apps/service.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { Chats, Conversations } from '../chats/service.ts'
import { Home } from '../home/service.ts'
import { settledDetails } from '../mcp/kept-app.ts'
import { toolAppResource } from '../mcp/remote.ts'
import { McpConnections, McpServers } from '../mcp/service.ts'
import { Apps } from './service.ts'

/**
 * Keep the App of a call in one of the owner's conversations, read from its transcript: a call made before Apps were
 * kept, or shown again after it was closed. Its tool must still render that App.
 */
export const createOwnerApp = ({ conversation, callId }: CreateApp) =>
  Effect.gen(function* () {
    const session = yield* Conversations.use((conversations) => conversations.require(conversation))
    const apps = yield* Apps
    const call = yield* apps.call(session, callId)
    const snapshot = yield* McpConnections.use((connections) => connections.connect(call.connectionId))
    const tool = snapshot.tools.find(({ name }) => name === call.tool)
    const uri = tool === undefined ? undefined : toolAppResource(tool)
    if (uri === undefined) return yield* new NotFound({ what: 'app' })
    const origin = { connectionId: call.connectionId, tool: call.tool, uri, title: tool?.title ?? call.tool }
    return yield* apps.register(session, callId, origin)
  })

/** The one thread a server's own App lives in: its thread operation from Personal, the same id on every open. */
const serverThreadOp = (connectionId: string) => `server-app:${connectionId}`

/**
 * Open a connection's own App (ADR 0053): the one thread kept for it (made on the first open, under Personal, named
 * after the server, reopened if the owner closed it) and the App kept there. Its tool must still declare that App; the
 * tool itself is called by the browser, as the owner, on each open.
 */
export const openServerApp = ({ connectionId }: OpenServerApp) =>
  Effect.gen(function* () {
    const server = (yield* McpServers.use((servers) => servers.list())).find(
      (each) => each.connectionId === connectionId,
    )
    const tool = server?.profile?.app?.tool ?? server?.entrypoint
    if (server === undefined || tool === undefined) return yield* new NotFound({ what: 'server app' })
    const title = server.profile?.title ?? server.title ?? server.label
    if (server.status !== 'connected') return yield* new InvalidInput({ reason: `Sign in to ${title} first` })
    const snapshot = yield* McpConnections.use((connections) => connections.connect(connectionId))
    const declared = snapshot.tools.find(({ name }) => name === tool)
    const uri = declared === undefined ? undefined : toolAppResource(declared)
    if (uri === undefined) return yield* new NotFound({ what: 'server app' })
    const conversations = yield* Conversations
    const { primary } = yield* Chats
    let thread = yield* conversations.startThread(primary, serverThreadOp(connectionId), 'empty')
    if (thread.closedAt !== undefined) thread = (yield* conversations.update(thread.id, { closed: false })).view
    if (thread.title === undefined) thread = (yield* conversations.update(thread.id, { title })).view
    const session = yield* conversations.require(thread.id)
    return yield* Apps.use((apps) => apps.registerServer(session, { connectionId, tool, uri, title }))
  })

/** Close an App, or open it again. */
export const updateOwnerApp = (id: string, change: UpdateApp) => Apps.use((apps) => apps.update(id, change.closed))

/** What the browser needs to load an App; it grants nothing (its calls are checked live). */
export const launchOwnerApp = (id: string) =>
  Effect.gen(function* () {
    const launch = yield* Apps.use((apps) => apps.launch(id))
    // A call the owner approved, or a URL request they finished, shows the server's real answer, not its placeholder.
    return launch.kind === 'mcp' ? { ...launch, result: yield* settledDetails(launch.result) } : launch
  })

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
      const conversations = yield* Conversations
      yield* conversations.requireOpen(change.conversation)
      if ((yield* conversations.kindOf(change.conversation)) === 'subagent')
        return yield* new InvalidInput({ reason: "an app's home is main or a thread" })
      yield* engine.moveHome(name, change.conversation)
    } else yield* engine.change(name, change)
    return yield* agentAppDetail(name)
  })

/** The owner deletes an agent app, confirmed by its name: its schedules, files and data go, and its App. */
export const deleteAgentApp = (name: string, input: DeleteAgentApp) =>
  Effect.gen(function* () {
    if (input.confirm !== name) return yield* new InvalidInput({ reason: `type ${name} to delete it` })
    yield* AppEngine.use((engine) => engine.remove(name))
    yield* Apps.use((apps) => apps.removeAgent(name))
    yield* Home.use((home) => home.appRemoved)
    return { deleted: name }
  })
