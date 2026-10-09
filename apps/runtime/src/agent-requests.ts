import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { type AppError, NotFound } from './http/errors.ts'
import { refusal } from './http/api/render.ts'
import { type AgentServices, attempt } from './services.ts'
import { registeredConversation } from './agent-program.ts'
import { piEventResponse } from './pi/events.ts'
import { Workspace } from './workspace/service.ts'
import { filesRequest } from './files/routes.ts'
import { inspectRequest } from './inspect/request.ts'
import type { JsonObject } from '@goblin/contracts'
import { connectCallback } from './mcp/program.ts'

type Execute = <A>(program: Effect.Effect<A, AppError, AgentServices>) => Promise<Exit.Exit<A, AppError>>
export async function sessionSnapshot(harness: PiHarness, session: string): Promise<JsonObject> {
  const stream = await harness.session(session).events()
  const snapshot = stream.snapshot
  await stream.stop()
  // SAFETY: Pi snapshots are structured cloneable; normalization enforces JSON at the RPC boundary.
  return JSON.parse(JSON.stringify(snapshot)) as JsonObject
}
/** RPC snapshots take the same registered chat identity as the HTTP routes. */
export const chatSnapshot = (harness: PiHarness, chat: string) =>
  Effect.flatMap(registeredConversation(chat), (session) => attempt(() => sessionSnapshot(harness, session)))

const EVENTS = /^\/api\/conversations\/(\d{1,12})\/events$/u

/**
 * The agent's raw routes: what is not JSON in and out, so not an owner API endpoint (`http/api/server.ts` answers
 * those first). The Worker's edge forwards each with its path unchanged after admitting the owner (session, CSRF on
 * writes, plan); none of them renews resident authority. `/inspect` is the one path the Worker reaches on its own, from
 * `/mcp` for a client that holds `goblin:inspect`.
 *
 * - `GET /api/conversations/:id/events`: the chat's Pi event stream (SSE).
 * - `GET /api/workspace/events`: the workspace feed (SSE).
 * - `/api/files` and `/api/files/content`: the owner's file bytes (`files/routes.ts`).
 * - `GET /api/mcp/oauth/callback`: an outbound sign-in coming back, answered with a redirect to Connections.
 */
export async function agentRequest(
  request: Request,
  harness: PiHarness,
  execute: Execute,
  appUrl: string,
): Promise<Response> {
  const url = new URL(request.url)
  const ref = request.headers.get('x-goblin-ref') ?? undefined
  if (url.pathname === '/inspect') return inspectRequest(request, execute)
  if (request.method === 'GET' && url.pathname === '/api/workspace/events') {
    const feed = await execute(Workspace.use((workspace) => workspace.events))
    return Exit.isSuccess(feed) ? feed.value : Response.json({ error: 'Unavailable' }, { status: 503 })
  }
  if (url.pathname === '/api/files' || url.pathname.startsWith('/api/files/'))
    return filesRequest(request, url, execute)
  if (request.method === 'GET' && url.pathname === '/api/mcp/oauth/callback') {
    return signInRedirect(await execute(connectCallback(url.searchParams, appUrl)), appUrl, ref)
  }
  const chat = request.method === 'GET' ? EVENTS.exec(url.pathname)?.[1] : undefined
  if (chat !== undefined) return eventsResponse(chat, harness, execute)
  return refusal(new NotFound({ what: 'route' }), ref)
}

/** A chat's Pi event stream: a chat keeps its Pi session (a Move makes a new Thread), so the stream is its session's. */
async function eventsResponse(chat: string, harness: PiHarness, execute: Execute): Promise<Response> {
  const session = await execute(registeredConversation(chat))
  if (Exit.isFailure(session)) return Response.json({ error: 'NotFound' }, { status: 404 })
  return piEventResponse(await harness.session(session.value).events())
}

/** Where an outbound sign-in returns the owner: Connections, quoting the request's reference when it failed. */
function signInRedirect(target: Exit.Exit<URL, unknown>, appUrl: string, ref: string | undefined): Response {
  const location = Exit.isSuccess(target) ? target.value : new URL('/connections?error=Internal', appUrl)
  if (location.searchParams.has('error') && ref !== undefined) location.searchParams.set('ref', ref)
  return Response.redirect(location.href, 302)
}
