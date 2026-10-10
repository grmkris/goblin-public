import type {
  CapabilityChange,
  CreateConversation,
  MoveToThread,
  QueueRemoval,
  SendMessage,
  StartThread,
  StopConversation,
  UpdateConversation,
} from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import {
  createOwnerConversation,
  markOwnerRead,
  registeredConversation,
  sendOwnerMessage,
  stopChat,
  updateOwnerConversation,
} from '../agent-program.ts'
import { capabilitiesOf, changeCapabilities } from '../capabilities/program.ts'
import { composerOptions } from '../composer.ts'
import { ownerQueue, removeOwnerQueuedInput } from '../conversation-queue.ts'
import { AgentInput } from '../runtime/input.ts'
import { Retrieval } from '../retrieval/service.ts'
import { attempt, toAppError } from '../http/errors.ts'
import { piEventResponse, sessionSnapshot } from '../pi/events.ts'
import { PiSessions } from '../pi/sessions.ts'
import { Conversations } from './service.ts'
import { moveToThread } from './mover.ts'
import { startThread } from './thread-heads.ts'

/** A request that names one chat (`/conversations/:id/…`), and one that also carries a body. */
type ChatRequest = { readonly params: { readonly id: string } }
type ChatWrite<Payload> = ChatRequest & { readonly payload: Payload }

/** What came with the owner's message: App context, files and composer tags, and `personaOrder` when the body had one. */
const contextOf = ({
  appContext = [],
  attachments = [],
  selections = [],
  personaOrder,
}: Pick<SendMessage, 'appContext' | 'attachments' | 'selections' | 'personaOrder'>) => ({
  appContext,
  attachments,
  selections,
  ...(personaOrder === undefined ? {} : { personaOrder }),
})

/** The owner's message into a chat, or an ask of the Personas it tags. */
const submit = ({ params, payload }: ChatWrite<SendMessage>) =>
  sendOwnerMessage(params.id, { text: payload.input, operationId: payload.operationId, context: contextOf(payload) })

/**
 * The unified thread operation from a chat (ADR 0034): Reply at an entry, "+" empty, or Start thread at the chat's
 * newest settled entry, the first message answered in the Thread, its Personas in the order it asks (the Worker's old
 * route dropped `personaOrder`, H1).
 */
const threadStart = ({ params, payload }: ChatWrite<StartThread>) =>
  startThread({
    parent: params.id,
    anchor: payload.anchor,
    text: payload.message.input,
    operationId: payload.operationId,
    context: contextOf({ ...payload.message, personaOrder: payload.personaOrder }),
  })

const create = ({ payload }: { readonly payload: CreateConversation }) => createOwnerConversation(payload)
const update = ({ params, payload }: ChatWrite<UpdateConversation>) => updateOwnerConversation(params.id, payload)
const move = ({ params, payload }: ChatWrite<MoveToThread>) => moveToThread(params.id, payload)
const stop = ({ params, payload }: ChatWrite<StopConversation>) =>
  Effect.map(stopChat(params.id, payload.operationId), (stopped) => ({ stopped }))
const queue = ({ params }: ChatRequest) => ownerQueue(params.id)
const removeQueued = ({ params, payload }: ChatWrite<QueueRemoval>) => removeOwnerQueuedInput(params.id, payload)
const markRead = ({ params }: ChatRequest) => Effect.map(markOwnerRead(params.id), (read) => ({ read }))
const composer = ({ params }: ChatRequest) => composerOptions(params.id)

const capabilities = ({ params }: ChatRequest) => capabilitiesOf(params.id)

const setCapability = ({ params, payload }: ChatWrite<CapabilityChange>) => changeCapabilities(params.id, payload)

/** A registered chat's Pi snapshot. */
const snapshot = ({ params }: ChatRequest) =>
  Effect.flatMap(registeredConversation(params.id), (session) =>
    AgentInput.use(({ harness }) => attempt(() => sessionSnapshot(harness, session))),
  )

/** A page of a registered chat's history before entry `before`. */
const history = ({ params, query }: ChatRequest & { readonly query: { readonly before: number } }) =>
  Conversations.use((conversations) =>
    Effect.andThen(conversations.require(params.id), conversations.history(params.id, query.before)),
  )

/** What retrieval gave a registered chat's answers (ADR 0035), newest first: its source strips. */
const sources = ({ params }: ChatRequest) =>
  Effect.andThen(
    registeredConversation(params.id),
    Retrieval.use((retrieval) => retrieval.uses(params.id)),
  )

/**
 * A registered chat's Pi event stream, server-sent. The stream is its own: it runs until the browser goes away, past
 * the request's scope, and stops Pi's stream then.
 */
const events = ({ params }: ChatRequest) =>
  Effect.gen(function* () {
    const session = yield* registeredConversation(params.id)
    const stream = yield* PiSessions.use((pi) => pi.events(session)).pipe(
      Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
    )
    return HttpServerResponse.raw(piEventResponse(stream))
  })

/**
 * The `conversations` group (ADRs 0030, 0032, 0034). The owner gate has already admitted the request; the instance's
 * pieces (Pi, the routine controller, Stop) come from `AgentInput`.
 */
export const ConversationsHandlers = HttpApiBuilder.group(OwnerApi, 'conversations', (handlers) =>
  handlers
    .handle('create', create)
    .handle('update', update)
    .handle('submit', submit)
    .handle('startThread', threadStart)
    .handle('move', move)
    .handle('stop', stop)
    .handle('queue', queue)
    .handle('removeQueued', removeQueued)
    .handle('markRead', markRead)
    .handle('capabilities', capabilities)
    .handle('setCapability', setCapability)
    .handle('composer', composer)
    .handle('snapshot', snapshot)
    .handle('history', history)
    .handle('sources', sources)
    .handleRaw('events', events),
)
