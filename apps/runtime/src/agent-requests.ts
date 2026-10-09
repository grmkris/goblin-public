import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { type AppError } from './http/errors.ts'
import { type AgentServices, Chats, Conversations, Retrieval, Workspace, attempt } from './services.ts'
import { registeredConversation } from './agent-program.ts'
import { piEventResponse } from './pi/events.ts'
import { workspaceEventResponse } from './workspace/feed.ts'
import { filesRequest } from './files/routes.ts'
import { inspectRequest } from './inspect/request.ts'
import type { JsonObject } from '@goblin/contracts'
import { homeRequest } from './home/routes.ts'

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

export async function agentRequest(request: Request, harness: PiHarness, execute: Execute): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/home') return homeRequest(request, execute)
  if (url.pathname === '/workspace/events') {
    const feed = await execute(Workspace.useSync((workspace) => workspace))
    return Exit.isSuccess(feed)
      ? workspaceEventResponse(feed.value)
      : Response.json({ error: 'Unavailable' }, { status: 503 })
  }
  if (url.pathname === '/files' || url.pathname.startsWith('/files/')) return filesRequest(request, url, execute)
  if (url.pathname === '/inspect') return inspectRequest(request, execute)
  return conversationRequest(url, harness, execute)
}
/** What the chat's answers retrieved from other chats (ADR 0035), newest first: its source strips. */
async function sourcesResponse(chat: string, execute: Execute): Promise<Response> {
  const uses = await execute(Retrieval.useSync((retrieval) => retrieval.index.uses(chat)))
  return Exit.isSuccess(uses) ? Response.json(uses.value) : Response.json({ error: 'Unavailable' }, { status: 503 })
}
async function conversationRequest(url: URL, harness: PiHarness, execute: Execute): Promise<Response> {
  const [, id = '', view = ''] =
    /^\/conversations\/(\d{1,12})\/(events|snapshot|history|sources)$/u.exec(url.pathname) ?? []
  const session = await execute(registeredConversation(id))
  if (view === '' || Exit.isFailure(session)) return Response.json({ error: 'NotFound' }, { status: 404 })
  if (view === 'events') {
    const directory = await execute(Chats.useSync((chats) => chats))
    if (Exit.isFailure(directory)) return Response.json({ error: 'Unavailable' }, { status: 503 })
    return piEventResponse(await harness.session(session.value).events(), (close) =>
      directory.value.onRebind((chat) => {
        if (chat === id) close()
      }),
    )
  }
  if (view === 'snapshot') return Response.json(await sessionSnapshot(harness, session.value))
  if (view === 'sources') return sourcesResponse(id, execute)
  const before = Number(url.searchParams.get('before'))
  if (!Number.isSafeInteger(before) || before < 1) return Response.json({ error: 'InvalidInput' }, { status: 400 })
  const page = await execute(Conversations.use((registry) => attempt(() => registry.history(id, before))))
  return Exit.isSuccess(page) ? Response.json(page.value) : Response.json({ error: 'NotFound' }, { status: 404 })
}
