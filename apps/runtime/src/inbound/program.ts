import type { PiHarness } from 'agents/harness/pi'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { Applied } from '../agent-model.ts'
import { Entitlements } from '../billing/gates.ts'
import { settledWithin } from '../chats/instance.ts'
import { ChatOperations, Chats } from '../chats/service.ts'
import { type AppError, attempt } from '../http/errors.ts'
import type { AgentServices } from '../layers/index.ts'
import { Resident } from '../mcp/service.ts'
import { authoredContent } from '../pi/content.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { recentMessages } from '../pi/transcript.ts'
import type { RunProgram } from '../runtime/bridge.ts'

/** An inbound request checks entitlement without renewing resident authority. */
export const clientRequest = <A>(program: Effect.Effect<A, AppError, AgentServices>) =>
  Effect.andThen(
    Entitlements.use((plans) => plans.require()),
    program,
  )

/**
 * An inbound client's question in main, answered when it settles within `waitMs`. `_run` is no longer read: the
 * session goes on the owner's model inside the admission (`ChatOperations.send`); agent.ts still passes it.
 */
export const askClient = (
  input: {
    harness: PiHarness
    applied: Applied
    author: string
    text: string
    operationId: string
    waitMs: number
  },
  _run?: RunProgram,
) =>
  Effect.gen(function* () {
    yield* (yield* Resident).require()
    const chats = yield* Chats
    const { session } = yield* (yield* ChatOperations).send({
      chat: chats.primary,
      operationId: input.operationId,
      receipt: { kind: 'ask_client', origin: 'client' },
      flow: { flow: 'ask_client', via: 'mcp', actor: 'client' },
      content: authoredContent(input.author, input.text),
    })
    const settled = yield* settledWithin(session, input.operationId, input.waitMs)
    if (Option.isNone(settled)) return { status: 'running' as const, operationId: input.operationId }
    const result = settled.value
    return result.status === 'done'
      ? { status: 'done' as const, operationId: input.operationId, text: result.text ?? '' }
      : { status: 'unanswered' as const, operationId: input.operationId, reason: result.reason ?? 'unanswered' }
  })

export const recentOwnerMessages = (harness: PiHarness, limit: number) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    const session = yield* chats.session(chats.primary)
    return yield* attempt(async () => {
      const main = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
      return main === undefined ? [] : recentMessages(main, limit)
    })
  })
