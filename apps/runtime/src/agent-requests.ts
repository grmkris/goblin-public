import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { type AppError } from './http/errors.ts'
import { type AgentServices, Conversations, Workspace, attempt } from './services.ts'
import { registeredConversation } from './agent-program.ts'
import { piEventResponse } from './pi/events.ts'
import { workspaceEventResponse } from './workspace/feed.ts'
import { filesRequest } from './files/routes.ts'
import { inspectRequest, operatorReadsRequest } from './inspect/request.ts'
import type { JsonObject } from '@goblin/contracts'

type Execute = <A>(program: Effect.Effect<A, AppError, AgentServices>) => Promise<Exit.Exit<A, AppError>>
export async function sessionSnapshot(harness: PiHarness, session: string): Promise<JsonObject> {
  const stream = await harness.session(session).events()
  const snapshot = stream.snapshot
  await stream.stop()
  // SAFETY: Pi snapshots are structured cloneable; normalization enforces JSON at the RPC boundary.
  return JSON.parse(JSON.stringify(snapshot)) as JsonObject
}
export async function agentRequest(request: Request, harness: PiHarness, execute: Execute): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/workspace/events') {
    const feed = await execute(Workspace.useSync((workspace) => workspace))
    return Exit.isSuccess(feed)
      ? workspaceEventResponse(feed.value)
      : Response.json({ error: 'Unavailable' }, { status: 503 })
  }
  if (url.pathname === '/files' || url.pathname.startsWith('/files/')) return filesRequest(request, url, execute)
  if (url.pathname === '/inspect') return inspectRequest(request, execute)
  if (url.pathname === '/operator-reads') return operatorReadsRequest(request, url, execute)
  return conversationRequest(url, harness, execute)
}
async function conversationRequest(url: URL, harness: PiHarness, execute: Execute): Promise<Response> {
  const [, id = '', view = ''] = /^\/conversations\/(\d{1,12})\/(events|snapshot|history)$/u.exec(url.pathname) ?? []
  const session = await execute(registeredConversation(id))
  if (view === '' || Exit.isFailure(session)) return Response.json({ error: 'NotFound' }, { status: 404 })
  if (view === 'events') return piEventResponse(await harness.session(session.value).events())
  if (view === 'snapshot') return Response.json(await sessionSnapshot(harness, session.value))
  const before = Number(url.searchParams.get('before'))
  if (!Number.isSafeInteger(before) || before < 1) return Response.json({ error: 'InvalidInput' }, { status: 400 })
  const page = await execute(Conversations.use((registry) => attempt(() => registry.history(session.value, before))))
  return Exit.isSuccess(page) ? Response.json(page.value) : Response.json({ error: 'NotFound' }, { status: 404 })
}
