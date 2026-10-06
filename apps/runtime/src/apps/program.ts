import type { AppCall, AppDiagnostic, AppPowerChange, CreateApp, UpdateApp } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { NotFound } from '../http/errors.ts'
import { toolAppResource } from '../mcp/connection.ts'
import { AppEngine, Apps, Conversations, Mcp, attempt, attemptSync, nowSecondsEffect } from '../services.ts'

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

/** The powers an agent app asks for, with the owner's answers. */
export const agentAppPowers = (name: string) => AppEngine.use((engine) => attemptSync(() => engine.powers(name)))

/** The owner approves or revokes one power of an agent app. */
export const answerAgentAppPower = (name: string, change: AppPowerChange) =>
  AppEngine.use((engine) =>
    attemptSync(() => engine.answer(name, { kind: change.kind, target: change.target }, change.allowed)),
  )
