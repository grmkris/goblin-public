import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { settledWithin } from '../chats/instance.ts'
import { ChatOperations, Chats } from '../chats/service.ts'
import { attempt, toAppError } from '../http/errors.ts'
import { requireResident } from '../mcp/service.ts'
import { authoredContent } from '../pi/content.ts'
import { PiSessions } from '../pi/sessions.ts'
import { recentMessages } from '../pi/transcript.ts'

/** An inbound client's question in main, labelled with its name, answered when it settles within `waitMs`. */
export const askClient = (input: {
  readonly author: string
  readonly input: string
  readonly operationId: string
  readonly waitMs: number
}) =>
  Effect.gen(function* () {
    yield* requireResident
    const chats = yield* Chats
    const { session } = yield* (yield* ChatOperations).send({
      chat: chats.primary,
      operationId: input.operationId,
      receipt: { kind: 'ask_client', origin: 'client' },
      flow: { flow: 'ask_client', via: 'mcp', actor: 'client' },
      content: authoredContent(input.author, input.input),
    })
    const settled = yield* settledWithin(session, input.operationId, input.waitMs)
    if (Option.isNone(settled)) return { status: 'running' as const, operationId: input.operationId }
    const result = settled.value
    return result.status === 'done'
      ? { status: 'done' as const, operationId: input.operationId, text: result.text ?? '' }
      : { status: 'unanswered' as const, operationId: input.operationId, reason: result.reason ?? 'unanswered' }
  })

/** The newest `limit` messages of main, from its whole history; none before main has a conversation. */
export const recentOwnerMessages = (limit: number) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    const session = yield* chats.session(chats.primary)
    const main = yield* (yield* PiSessions)
      .conversation(session)
      .pipe(Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))))
    if (Option.isNone(main)) return []
    const conversation = main.value
    return yield* attempt(() => recentMessages(conversation, limit))
  })
