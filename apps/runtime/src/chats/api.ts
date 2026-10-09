import type {
  CapabilityChange,
  CreateConversation,
  MoveToThread,
  QueueRemoval,
  SendMessage,
  UpdateConversation,
} from '@goblin/contracts'
import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import {
  createOwnerConversation,
  markOwnerRead,
  registeredConversation,
  stopOwner,
  submitOwner,
  updateOwnerConversation,
} from '../agent-program.ts'
import { chatSnapshot } from '../agent-requests.ts'
import { capabilitiesOf, changeCapabilities } from '../capabilities/program.ts'
import { composerOptions } from '../composer.ts'
import { ownerQueue, removeOwnerQueuedInput } from '../conversation-queue.ts'
import { type AgentInputs, AgentInput } from '../runtime/input.ts'
import { Conversations, Retrieval, attempt, attemptSync } from '../services.ts'
import { moveToThread } from './mover.ts'
import { startThread } from './thread-heads.ts'

/** A request that names one chat (`/conversations/:id/…`), and one that also carries a body. */
type ChatRequest = { readonly params: { readonly id: string } }
type ChatWrite<Payload> = ChatRequest & { readonly payload: Payload }

/** What the owner's message paths run with, from the agent's instance (agent.ts `#submitRuntime`). */
const submitRuntime = ({ harness, applied, routines, subagents, personas, run }: AgentInputs) => ({
  harness,
  applied,
  routines,
  subagents,
  personas,
  run,
})

/** What came with the owner's message: App context, files and composer tags, and `personaOrder` when the body had one. */
const contextOf = ({ appContext = [], attachments = [], selections = [], personaOrder }: SendMessage) => ({
  appContext,
  attachments,
  selections,
  ...(personaOrder === undefined ? {} : { personaOrder }),
})

/** The owner's message into a chat, or an ask of the Personas it tags. */
const submit = ({ params, payload }: ChatWrite<SendMessage>) =>
  AgentInput.use((input) =>
    submitOwner({
      ...submitRuntime(input),
      thread: params.id,
      text: payload.input,
      operationId: payload.operationId,
      context: contextOf(payload),
    }),
  )

/**
 * The owner's message as the head of a new Thread, its Personas answering there in the order it asks. The Worker's
 * `POST threads` route dropped `personaOrder` (H1), so tagged Personas always answered in parallel.
 */
const threadStart = ({ params, payload }: ChatWrite<SendMessage>) =>
  AgentInput.use((input) =>
    startThread({
      ...submitRuntime(input),
      parent: params.id,
      text: payload.input,
      operationId: payload.operationId,
      context: contextOf(payload),
    }),
  )

/** Every registered chat, closed ones included. */
const list = () => Conversations.use((conversations) => attempt(() => conversations.list()))
const create = ({ payload }: { readonly payload: CreateConversation }) => createOwnerConversation(payload)
const update = ({ params, payload }: ChatWrite<UpdateConversation>) =>
  AgentInput.use(({ routines }) => updateOwnerConversation(routines, params.id, payload))
const move = ({ params, payload }: ChatWrite<MoveToThread>) => moveToThread(params.id, payload)
const stop = ({ params, payload }: ChatWrite<{ readonly operationId?: string | undefined }>) =>
  AgentInput.use(({ stopping }) =>
    Effect.map(stopOwner({ ...stopping(), thread: params.id, operationId: payload.operationId }), (stopped) => ({
      stopped,
    })),
  )
const queue = ({ params }: ChatRequest) => AgentInput.use(({ harness }) => ownerQueue(harness, params.id))
const removeQueued = ({ params, payload }: ChatWrite<QueueRemoval>) =>
  AgentInput.use(({ harness }) => removeOwnerQueuedInput(harness, params.id, payload))
const markRead = ({ params }: ChatRequest) => Effect.map(markOwnerRead(params.id), (read) => ({ read }))
const composer = ({ params }: ChatRequest) => AgentInput.use(({ run }) => composerOptions(params.id, run))

const capabilities = ({ params }: ChatRequest) => capabilitiesOf(params.id)

const setCapability = ({ params, payload }: ChatWrite<CapabilityChange>) => changeCapabilities(params.id, payload)

/** The chat's Pi snapshot, as the raw route served it. */
const snapshot = ({ params }: ChatRequest) => AgentInput.use(({ harness }) => chatSnapshot(harness, params.id))

/** A page of a registered chat's history before entry `before`. */
const history = ({ params, query }: ChatRequest & { readonly query: { readonly before: number } }) =>
  Effect.andThen(
    registeredConversation(params.id),
    Conversations.use((registry) => attempt(() => registry.history(params.id, query.before))),
  )

/** What retrieval gave a registered chat's answers (ADR 0035), newest first: its source strips. */
const sources = ({ params }: ChatRequest) =>
  Effect.andThen(
    registeredConversation(params.id),
    Retrieval.use((retrieval) => attemptSync(() => retrieval.index.uses(params.id))),
  )

/**
 * The `conversations` group (ADRs 0030, 0032, 0034): each handler runs the program its Durable Object RPC method ran
 * (agent.ts), or that its raw route ran (agent-requests.ts) for the snapshot, history and sources. The owner gate has
 * already admitted the request; the instance's pieces (Pi, the routine controller, Stop) come from `AgentInput`.
 */
export const ConversationsHandlers = HttpApiBuilder.group(OwnerApi, 'conversations', (handlers) =>
  handlers
    .handle('list', list)
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
    .handle('sources', sources),
)
