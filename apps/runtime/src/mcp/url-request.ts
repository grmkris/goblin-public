import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { RoutineRuns } from '../routines/service.ts'
import { type McpCallInput, waitOnOwner } from './approval-request.ts'
import { urlRequiredResult } from './extension.ts'
import { named } from './labels.ts'
import { McpConnections, McpServers, UrlRequests } from './service.ts'
import type { UrlPrompt } from './types.ts'
import { urlRequestId } from './url-requests.ts'

/** How long a URL request waits on the owner at most. */
const URL_REQUEST_TTL = 86_400_000

/**
 * A model's call the server answered with a URL request (ADR 0042): it is kept for the owner until a day passes, or
 * the routine run's deadline when that is sooner, and the turn ends waiting on them.
 */
export const holdUrlRequest = (
  session: string,
  callId: string,
  taskId: string,
  input: McpCallInput,
  prompt: UrlPrompt,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const run = yield* (yield* RoutineRuns).session(session)
    const deadline = run === undefined || run.deadlineAt <= now ? Number.POSITIVE_INFINITY : run.deadlineAt
    const server = yield* (yield* McpConnections).server(input.connectionId)
    const row = yield* (yield* UrlRequests).hold({
      id: urlRequestId(session, callId),
      sessionId: session,
      sourceCallId: callId,
      taskId,
      connectionId: input.connectionId,
      name: input.name,
      endpoint: server.endpoint,
      arguments: input.arguments,
      ...prompt,
      expiresAt: Math.min(now + URL_REQUEST_TTL, deadline),
    })
    const connection = named(yield* (yield* McpServers).labels(), input.connectionId)
    yield* waitOnOwner(session, callId, 'mcp-url', `Finish ${connection} · ${input.name} in goblin's card?`)
    return urlRequiredResult(row.id, input.connectionId, input.name, connection)
  })
