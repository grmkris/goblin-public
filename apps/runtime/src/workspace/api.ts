import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { sseFrames } from './feed.ts'
import { Workspace } from './service.ts'

const SSE_HEADERS = { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' }

/**
 * The feed as Server-Sent Events: `event: snapshot`, then `event: change` batches. The body runs the stream on its own,
 * with the agent's services, until the browser goes away, past the request's scope; the stream lets go of the feed
 * then.
 */
const events = Effect.fn('Workspace.events')(function* () {
  const { stream } = yield* Workspace
  const context = yield* Effect.context()
  return HttpServerResponse.raw(
    new Response(Stream.toReadableStreamWith(sseFrames(stream), context), { headers: SSE_HEADERS }),
  )
})

/** The `workspace` group: the feed, server-sent. */
export const WorkspaceHandlers = HttpApiBuilder.group(OwnerApi, 'workspace', (handlers) =>
  handlers.handleRaw('events', events),
)
