import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import {
  type CreateConversation,
  type HelperExclusion,
  type MoveToThread,
  PERSONAL_TOPIC,
  type UpdateConversation,
} from '@goblin/contracts'
import type { EntryDraft, Submission } from '@earendil-works/pi-durable'
import * as Clock from 'effect/Clock'
import type { Budget } from '../budget.ts'
import { makeChatOperations } from '../chats/operations.ts'
import type { ChatDirectory } from '../chats/directory.ts'
import { ChatOperations, Chats, Conversations, Moves, type RoutineReport, type ThreadAnchor } from '../chats/service.ts'
import type { ConversationRegistry } from '../conversations.ts'
import type { Models } from '../models.ts'
import type { AppError } from '../http/errors.ts'
import { FlowEvents } from '../observability/flows.ts'
import { safeErrorType } from '../observability/report.ts'
import { failedFlow } from '../organize/flows.ts'
import { BACKGROUND } from '../pi/context.ts'
import { Chats as LegacyChats, Conversations as LegacyConversations, Moves as LegacyMoves } from '../services.ts'
import { attempt, attemptSync, nowSecondsEffect } from '../services.ts'
import type { FoundationServices } from './core.ts'

/** The chat directory's reads over the legacy `ChatDirectory`. */
export const ChatsAdapter = Layer.effect(
  Chats,
  Effect.gen(function* () {
    const chats = yield* LegacyChats
    return Chats.of({
      primary: chats.primary(),
      session: Effect.fn('Chats.session')(function* (chat: string) {
        return yield* attemptSync(() => chats.session(chat))
      }),
      chatOf: Effect.fn('Chats.chatOf')(function* (session: string) {
        return Option.fromNullishOr(yield* attemptSync(() => chats.chatOf(session)))
      }),
      topicOf: Effect.fn('Chats.topicOf')(function* (chat: string) {
        return yield* attemptSync(() => chats.topicOf(chat))
      }),
      conversationOf: Effect.fn('Chats.conversationOf')(function* (topic: number) {
        return yield* attemptSync(() => chats.conversationOf(topic))
      }),
      conversationAbove: Effect.fn('Chats.conversationAbove')(function* (chat: string) {
        return yield* attemptSync(() => chats.conversationAbove(chat))
      }),
      isConversation: Effect.fn('Chats.isConversation')(function* (chat: string) {
        return yield* attemptSync(() => chats.isConversation(chat))
      }),
      isHidden: Effect.fn('Chats.isHidden')(function* (chat: string) {
        return yield* attemptSync(() => chats.isHidden(chat))
      }),
    })
  }),
)

/**
 * The chat operations natively (chats/operations.ts) over the legacy start's chat directory and registry gate, the
 * agent's one instance of each until this layer builds them.
 */
export const ChatOperationsLive = Layer.effect(
  ChatOperations,
  Effect.gen(function* () {
    const chats = yield* LegacyChats
    const registry = yield* LegacyConversations
    return yield* makeChatOperations({ chats, requireOpen: (chat) => registry.requireOpen(chat) })
  }),
)

/** The registry's reads over the legacy `ConversationRegistry`. */
const registryReads = (conversations: ConversationRegistry) => ({
  require: Effect.fn('Conversations.require')(function* (chat: string) {
    return yield* attemptSync(() => conversations.require(chat))
  }),
  requireOpen: Effect.fn('Conversations.requireOpen')(function* (chat: string) {
    return yield* attemptSync(() => conversations.requireOpen(chat))
  }),
  kindOf: Effect.fn('Conversations.kindOf')(function* (chat: string) {
    return yield* attemptSync(() => conversations.kindOf(chat))
  }),
  spawnerSession: Effect.fn('Conversations.spawnerSession')(function* (chat: string) {
    return yield* attemptSync(() => conversations.spawnerSession(chat))
  }),
  view: Effect.fn('Conversations.view')(function* (chat: string) {
    return Option.fromNullishOr(yield* attempt(() => conversations.view(chat)))
  }),
  list: Effect.withSpan(
    attempt(() => conversations.list()),
    'Conversations.list',
  ),
  helperReference: Effect.fn('Conversations.helperReference')(function* (chat: string) {
    return yield* attempt(() => conversations.helperReference(chat))
  }),
  openIn: Effect.fn('Conversations.openIn')(function* (topic: number) {
    return yield* attemptSync(() => conversations.openIn(topic))
  }),
  recallAt: Effect.fn('Conversations.recallAt')(function* (chat: string, entry: number) {
    return yield* attemptSync(() => conversations.recallAt(chat, entry))
  }),
  recallLimit: Effect.fn('Conversations.recallLimit')(function* (session: string, size: number) {
    return yield* attemptSync(() => conversations.recallLimit(session, size))
  }),
  history: Effect.fn('Conversations.history')(function* (chat: string, before: number) {
    return yield* attempt(() => conversations.history(chat, before))
  }),
  subtree: Effect.fn('Conversations.subtree')(function* (chat: string) {
    return yield* attemptSync(() => conversations.subtree(chat))
  }),
})

/** The registry's new chats over the legacy `ConversationRegistry`: Threads, Topic Conversations and registrations. */
const registryChats = (conversations: ConversationRegistry) => ({
  openConversation: Effect.withSpan(
    attempt(() => conversations.openConversation()),
    'Conversations.openConversation',
  ),
  registerSubagent: Effect.fn('Conversations.registerSubagent')(function* (
    session: string,
    parent: string,
    name: string,
    exclusions: readonly HelperExclusion[] = [],
  ) {
    const now = yield* nowSecondsEffect
    return yield* attemptSync(() => conversations.registerSubagent(session, parent, name, now, exclusions))
  }),
  registerPersona: Effect.fn('Conversations.registerPersona')(function* (
    session: string,
    parentChat: string,
    name: string,
  ) {
    const now = yield* nowSecondsEffect
    return yield* attempt(() => conversations.registerPersona(session, parentChat, name, now))
  }),
  registerRoutine: Effect.fn('Conversations.registerRoutine')(function* (
    session: string,
    runId: string,
    title: string,
    topic?: number,
  ) {
    const now = yield* nowSecondsEffect
    return yield* attemptSync(() => conversations.registerRoutine(session, runId, title, now, topic))
  }),
})

/** The flow, and the receipt's kind, of a thread operation by where it starts its Thread. */
const threadFlow = (anchor: ThreadAnchor) => (anchor === 'latest' ? 'start' : anchor === 'empty' ? 'empty' : 'reply')

/**
 * Thread operations (ADR 0034) over the legacy registry: the Thread made once per operation, its receipt in the chat it
 * came from (moved on to `settled` with the Thread it made), and its `start`, `reply` or `empty` flow. A create with an
 * operation id is that chat's thread operation (C4); one without stays the plain create it always was.
 */
const threadStarts = (
  conversations: ConversationRegistry,
  chats: ChatDirectory,
  operations: ChatOperations['Service'],
  flows: FlowEvents['Service'],
) => {
  const startThread = Effect.fn('Conversations.startThread')(function* (
    parent: string,
    operationId: string,
    anchor: ThreadAnchor,
  ) {
    const kind = threadFlow(anchor)
    const flow = { flow: kind, via: 'app', actor: 'owner', parentChat: parent, operationId } as const
    const started = Effect.gen(function* () {
      yield* operations.record(parent, operationId, { kind, origin: 'owner' })
      const now = yield* nowSecondsEffect
      const { view, existing } = yield* attempt(() => conversations.startThread(parent, operationId, anchor, now))
      yield* operations.advance(parent, operationId, { state: 'settled', targetChat: view.id })
      yield* flows.record({ ...flow, chat: view.id, status: existing ? 'replayed' : 'ok' })
      return view
    })
    const refused = (error: AppError) =>
      Effect.andThen(
        flows.record({ ...flow, ...failedFlow(error) }),
        operations.advance(parent, operationId, { state: 'refused', reason: safeErrorType(error) }),
      )
    return yield* started.pipe(Effect.tapError(refused))
  })
  const create = Effect.fn('Conversations.create')(function* (input: CreateConversation) {
    const { from, topic, operationId } = input
    if (operationId !== undefined) {
      if (from !== undefined) return yield* startThread(from.conversation, operationId, { entry: from.entry })
      const channel = yield* attemptSync(() => chats.conversationOf(topic ?? PERSONAL_TOPIC))
      return yield* startThread(channel, operationId, 'empty')
    }
    const now = yield* nowSecondsEffect
    if (from !== undefined) return yield* attempt(() => conversations.branch(from.conversation, from.entry, now))
    const channel = yield* attemptSync(() => chats.conversationOf(topic ?? PERSONAL_TOPIC))
    return yield* attempt(() => conversations.createIn(channel, now))
  })
  return { startThread, create }
}

/** The registry's writes into existing chats over the legacy `ConversationRegistry`. */
/** A thread's note into the chat it came from, as its own `share` flow (plan §4). */
const shareBackWith = (
  conversations: ConversationRegistry,
  operations: ChatOperations['Service'],
  flows: FlowEvents['Service'],
) =>
  Effect.fn('Conversations.shareBack')(function* (thread: string, note: string, requestId: string) {
    const flow = { flow: 'share', via: 'tool', actor: 'agent', chat: thread, operationId: requestId } as const
    const shared = Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const { chat, write, sharedWith } = yield* attemptSync(() => conversations.shareBack(thread, note, requestId, at))
      yield* operations.passiveWrite(chat, write)
      yield* flows.record({ ...flow, parentChat: chat, status: 'ok' })
      return sharedWith
    })
    return yield* shared.pipe(Effect.tapError((error) => flows.record({ ...flow, ...failedFlow(error) })))
  })

const registryWrites = (
  conversations: ConversationRegistry,
  operations: ChatOperations['Service'],
  flows: FlowEvents['Service'],
) => ({
  touched: Effect.fn('Conversations.touched')(function* (chats: readonly string[]) {
    return yield* attemptSync(() => conversations.touched(chats))
  }),
  reportRoutine: Effect.fn('Conversations.reportRoutine')(function* (report: RoutineReport) {
    const { chat, write } = yield* attemptSync(() => conversations.routineReport(report))
    yield* operations.passiveWrite(chat, write)
  }),
  shareBack: shareBackWith(conversations, operations, flows),
  announce: Effect.fn('Conversations.announce')(function* (thread: string) {
    const at = yield* Clock.currentTimeMillis
    const owed = yield* attemptSync(() => conversations.announcement(thread, at))
    if (owed === undefined) return false
    yield* operations.passiveWrite(owed.chat, owed.write)
    return yield* attemptSync(() => conversations.announced(thread))
  }),
  writeEntry: Effect.fn('Conversations.writeEntry')(function* (chat: string, requestId: string, entry: EntryDraft) {
    const submission = yield* operations.passiveWrite(chat, { requestId, entry })
    return { placed: placedOf(submission) }
  }),
  nameIfUntitled: Effect.fn('Conversations.nameIfUntitled')(function* (thread: string) {
    return yield* attempt(() => conversations.nameIfUntitled(thread))
  }),
  update: Effect.fn('Conversations.update')(function* (chat: string, change: UpdateConversation) {
    const now = yield* nowSecondsEffect
    return yield* attempt(() => conversations.update(chat, change, now))
  }),
  markRead: Effect.fn('Conversations.markRead')(function* (chat: string) {
    const now = yield* nowSecondsEffect
    return yield* attemptSync(() => conversations.markRead(chat, now))
  }),
  close: Effect.fn('Conversations.close')(function* (chat: string, by: 'owner' | 'done') {
    const now = yield* nowSecondsEffect
    return yield* attempt(() => conversations.close(chat, by, now))
  }),
  stopSubagents: Effect.fn('Conversations.stopSubagents')(function* (chat: string) {
    return yield* attempt(() => conversations.stopSubagents(chat))
  }),
})

/**
 * Where a passive write landed: its entry id once it is in the transcript (at once when the chat is idle, else at its
 * next boundary), none when Pi did not place it. It waits outside the chat's lock.
 */
const placedOf = (submission: Submission) =>
  Effect.map(
    attempt(() => submission.wait(BACKGROUND)),
    (settled) =>
      settled.status === 'done' && settled.entry !== undefined ? Option.some(Number(settled.entry)) : Option.none(),
  )

/**
 * The registry over the legacy `ConversationRegistry`, reading the time from the Clock as the programs do. Its passive
 * writes go through `ChatOperations.passiveWrite`: under the chat's lock, each with its receipt.
 */
const ConversationsAdapter = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const conversations = yield* LegacyConversations
    const chats = yield* LegacyChats
    const operations = yield* ChatOperations
    const flows = yield* FlowEvents
    return Conversations.of({
      ...registryReads(conversations),
      ...registryChats(conversations),
      ...threadStarts(conversations, chats, operations, flows),
      ...registryWrites(conversations, operations, flows),
    })
  }),
)

/** Move to thread over the legacy `ChatMover`. */
const MovesAdapter = Layer.effect(
  Moves,
  Effect.gen(function* () {
    const moves = yield* LegacyMoves
    return Moves.of({
      move: Effect.fn('Moves.move')(function* (chat: string, input: MoveToThread) {
        const now = yield* nowSecondsEffect
        return yield* attempt(() => moves.move(chat, input, now))
      }),
      moving: Effect.fn('Moves.moving')(function* (chat: string) {
        return yield* attemptSync(() => moves.moving(chat))
      }),
    })
  }),
)

/**
 * Lane C's services: the conversation services (chats/service.ts), until wave 3 adapters over the one legacy instance
 * of each (layers/legacy.ts). They construct nothing of their own.
 */
export const ConversationLive: Layer.Layer<
  Chats | ChatOperations | Conversations | Moves,
  never,
  FoundationServices | Budget | Models
> = Layer.mergeAll(ChatsAdapter, Layer.provideMerge(ConversationsAdapter, ChatOperationsLive), MovesAdapter)
