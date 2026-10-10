import {
  type AppContext,
  type Attachment,
  type ComposerSelection,
  type ConversationView,
  type CreateConversation,
  type UpdateConversation,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Apps } from './apps/service.ts'
import { requireBudget } from './budget.ts'
import type { SessionId } from './chats/directory.ts'
import { epochSeconds } from './clock.ts'
import { ChatOperations, Conversations } from './chats/service.ts'
import { resolveSelections, type ResolvedSelections } from './composer.ts'
import { Files } from './files/service.ts'
import { withFlow } from './observability/flows.ts'
import { InvalidInput, attempt } from './http/errors.ts'
import { Invocations } from './personas/service.ts'
import { RoutineControl, RoutineRuns } from './routines/service.ts'
import { AgentInput } from './runtime/input.ts'
import { conversationId } from './pi/context.ts'
import { PiSessions } from './pi/sessions.ts'
import { fromPi } from './chats/operations.ts'
import { type SharedContext, ownerContent } from './pi/content.ts'
import { askPersonas } from './personas/ask.ts'

/** The registration gate for every owner conversation request. */
export const registeredConversation = (id: string) => Conversations.use((conversations) => conversations.require(id))

/**
 * A thread from a message of an open conversation (in that conversation's Topic), or an empty one under a Topic's
 * Conversation: `topic`'s, else Personal's.
 */
export const createOwnerConversation = (input: CreateConversation) =>
  Conversations.use((conversations) => conversations.create(input))

/**
 * Rename, close or reopen, or pin a subagent open. A Close settles the live routine runs among what it closes first, so
 * a routine stopped this way reads as stopped by the owner, never as failed.
 */
export const updateOwnerConversation = (id: string, change: UpdateConversation) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    if (change.closed === true) {
      const closing = new Set(yield* conversations.subtree(id))
      const live = (yield* (yield* RoutineRuns).live).filter(
        (run) => run.sessionId !== null && closing.has(run.sessionId),
      )
      const control = yield* RoutineControl
      for (const run of live) yield* control.stop(run.id, 'Closed by owner')
    }
    return (yield* conversations.update(id, change)).view
  })

/** The owner has seen a conversation's newest reply. */
export const markOwnerRead = (id: string) =>
  Effect.as(
    Conversations.use((conversations) => conversations.markRead(id)),
    true,
  )

/**
 * Stop in a conversation: its current work, a routine's run when it is one, the subagents it started and the Personas
 * asked in it (their unsettled answers are dropped).
 */
export const stopOwner = (input: { readonly thread: string; readonly operationId: string | undefined }) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const session = yield* conversations.require(input.thread)
    const run = yield* (yield* RoutineRuns).session(session)
    if (run !== undefined) {
      yield* RoutineControl.use((control) => control.stop(run.id))
      return true
    }
    yield* conversations.stopSubagents(input.thread)
    const invocations = yield* Invocations
    const now = yield* epochSeconds
    const { personas } = yield* AgentInput
    const pi = yield* PiSessions
    const harness = yield* fromPi(pi.pi)
    yield* attempt(() => personas.drop(harness, conversationId(session)))
    yield* invocations.stopChat(input.thread, now)
    return yield* fromPi(pi.abort(session, input.operationId))
  })

/**
 * Stop in `chat` as the owner's Stop does, with the instance's Pi, routines and Persona turns: the one stop path, which
 * a Topic's archive takes too. Records the `stop` flow: who stopped it, and whether anything was running (`count`).
 */
export const stopChat = (chat: string, operationId?: string, actor: 'owner' | 'agent' = 'owner') => {
  const flow = {
    flow: 'stop',
    via: actor === 'owner' ? 'app' : 'tool',
    actor,
    chat,
    ...(operationId === undefined ? {} : { operationId }),
  } as const
  return stopOwner({ thread: chat, operationId }).pipe(withFlow(flow, (stopped) => ({ count: stopped ? 1 : 0 })))
}

export type OwnerMessageContext = {
  readonly appContext?: readonly AppContext[]
  readonly attachments?: readonly string[]
  readonly selections?: readonly ComposerSelection[]
  /** With Persona selections: answer in parallel (the default) or one after the other ("then"). */
  readonly personaOrder?: 'parallel' | 'sequence'
}

export type OwnerSubmit = {
  thread: string
  text: string
  operationId: string
  context: OwnerMessageContext
  /** The operation this message is part of: a started thread's first message is its start's. */
  parentOp?: string
}

/** What the owner's open Apps shared, each with where it comes from, read from the App registry (never the browser). */
const sharedContext = (context: readonly AppContext[], conversation: string) =>
  Effect.forEach(context, ({ app, text }) =>
    Effect.map(
      Apps.use((apps) => apps.originOf(app, conversation)),
      (origin): SharedContext => ({ origin, text }),
    ),
  )

/** The owner's attached files as they are now: each must exist, or the message is refused. */
const attachedFiles = (paths: readonly string[]) =>
  Effect.forEach(
    paths,
    (path) =>
      Effect.map(
        Files.use((files) => files.stat(path)),
        ({ name, size, mimeType }): Attachment => ({ path, name, size, mimeType }),
      ),
    { concurrency: 'unbounded' },
  )

/**
 * The owner's message to a subagent: the subagent stays open after its job (the owner engaged with it), and the
 * message goes through a relay in its spawner, so the answer reports up with the owner's words quoted. While the
 * subagent works, the message steers it.
 */
const sendToSubagent = (
  input: OwnerSubmit,
  view: ConversationView,
  session: string,
  extra: {
    readonly attachments: readonly Attachment[]
    readonly shared: readonly SharedContext[]
    readonly selections: ResolvedSelections
  },
) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    yield* conversations.update(view.id, { keepOpen: true })
    const pi = yield* PiSessions
    const busy = yield* fromPi(pi.busy(session))
    const send = {
      subagent: session,
      spawner: yield* conversations.spawnerSession(view.id),
      title: view.title ?? 'subagent',
      content: ownerContent(input.text, extra.shared, extra.attachments, extra.selections),
      text: input.text,
      operationId: input.operationId,
      busy,
    }
    const { subagents } = yield* AgentInput
    const harness = yield* fromPi(pi.pi)
    const accepted = yield* attempt(() => subagents.ownerSend(harness, send))
    return { session, operationId: input.operationId, accepted }
  })

/** The owner's words as the answer to a routine's question waiting in the session they reach, when one is. */
const routineAnswer = (operationId: string, text: string) => (admitted: SessionId) =>
  RoutineControl.use((control) => control.answer(admitted, operationId, text))

/**
 * The owner's message into a chat, or an ask of the Personas it tags. Admission (the chat open, the operation recorded,
 * a routine's waiting question answered, the session on the owner's model, Pi's submit) runs under the chat's lock.
 */
export const submitOwner = (input: OwnerSubmit) =>
  Effect.gen(function* () {
    const {
      appContext = [],
      attachments: paths = [],
      selections: tagged = [],
      personaOrder = 'parallel',
    } = input.context
    const personaIds = tagged.flatMap((selection) => (selection.kind === 'persona' ? [selection.personaId] : []))
    const picks = tagged.filter((selection) => selection.kind !== 'persona')
    yield* requireBudget
    const conversations = yield* Conversations
    const session = yield* conversations.requireOpen(input.thread)
    if (input.text.trim() === '' && !picks.some((selection) => selection.kind === 'skill'))
      return yield* new InvalidInput({ reason: 'empty_message' })
    const attachments = yield* attachedFiles(paths)
    const shared = yield* sharedContext(appContext, input.thread)
    const selections = yield* resolveSelections(session, picks)
    const view = Option.getOrUndefined(yield* conversations.view(input.thread))
    const content = ownerContent(input.text, shared, attachments, selections)
    if (personaIds.length > 0) {
      if (view?.kind === 'subagent') return yield* new InvalidInput({ reason: 'persona_subagent' })
      return yield* askPersonas(input, personaIds, personaOrder, content)
    }
    const relay =
      view?.kind === 'subagent' && view.parent !== undefined
        ? (admitted: SessionId) => sendToSubagent(input, view, admitted, { attachments, shared, selections })
        : undefined
    return yield* (yield* ChatOperations).send<Conversations | RoutineControl | PiSessions | AgentInput>({
      chat: input.thread,
      operationId: input.operationId,
      receipt: { kind: 'send', origin: 'owner', ...(input.parentOp === undefined ? {} : { parentOp: input.parentOp }) },
      flow: { flow: 'send', via: 'app', actor: 'owner' },
      content,
      answer: routineAnswer(input.operationId, input.text),
      ...(relay === undefined ? {} : { relay }),
    })
  })

/** The owner's message into `chat` with what came with it, as the owner API and a decided approval send it. */
export const sendOwnerMessage = (
  chat: string,
  message: { readonly text: string; readonly operationId: string; readonly context?: OwnerMessageContext },
) => submitOwner({ thread: chat, text: message.text, operationId: message.operationId, context: message.context ?? {} })
