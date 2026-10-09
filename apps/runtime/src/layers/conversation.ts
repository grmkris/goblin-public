import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type { CreateConversation, HelperExclusion, MoveToThread, UpdateConversation } from '@goblin/contracts'
import type { EntryDraft } from '@earendil-works/pi-durable'
import { stopOwner, submitOwner } from '../agent-program.ts'
import {
  ChatOperations,
  Chats,
  Conversations,
  Moves,
  type OwnerMessage,
  type PassiveWrite,
  type RoutineReport,
} from '../chats/service.ts'
import type { ChatDirectory } from '../chats/directory.ts'
import { NotFound } from '../http/errors.ts'
import type { ConversationRegistry } from '../conversations.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { AgentInput } from '../runtime/input.ts'
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
 * Holds `chat`'s admission lock on the legacy directory, which the mover, the registry's passive writes and the
 * subagent relays still take: one lock per chat for old and new callers alike. The lock is held from when its turn
 * comes until the returned release runs. Wave 3 moves every caller onto `KeyedLock`.
 */
const legacyLock = (chats: ChatDirectory, chat: string) =>
  Effect.callback<() => void>((resume) => {
    chats
      .withChat(chat, () => new Promise<void>((release) => resume(Effect.succeed(() => release()))))
      // expected: the lock's own run never rejects, so neither does its promise.
      .catch(() => undefined)
  })

/**
 * Admission and passive writes over the legacy directory, the lock shared with its other callers, and the owner's send
 * and Stop. Those two read services of lanes whose layers come after this one, so they run their programs through the
 * bridge (a plan check and a fiber of their own) until wave 3 orders the layers for them.
 */
export const ChatOperationsAdapter = Layer.effect(
  ChatOperations,
  Effect.gen(function* () {
    const chats = yield* LegacyChats
    const input = yield* AgentInput
    const { harness, applied, routines, subagents, personas, run } = input
    return ChatOperations.of({
      admit: Effect.fn('ChatOperations.admit')(function* (chat: string, operationId: string) {
        const now = yield* nowSecondsEffect
        return yield* attemptSync(() => chats.admit(chat, operationId, now))
      }),
      operation: Effect.fn('ChatOperations.operation')(function* (chat: string, operationId: string) {
        return Option.fromNullishOr(yield* attemptSync(() => chats.operation(chat, operationId)))
      }),
      withChat: (chat, effect) =>
        Effect.acquireUseRelease(
          legacyLock(chats, chat),
          () => effect,
          (release) => Effect.sync(release),
        ).pipe(Effect.withSpan('ChatOperations.withChat')),
      passiveWrite: Effect.fn('ChatOperations.passiveWrite')(function* (chat: string, write: PassiveWrite) {
        return yield* attempt(() =>
          chats.passiveWrite(chat, async (session) => {
            const conversation = await (await harness.pi()).conversation(conversationId(session), BACKGROUND)
            if (conversation === undefined) throw new NotFound({ what: 'conversation' })
            return conversation.submit({ type: 'write', ...write }, BACKGROUND)
          }),
        )
      }),
      send: Effect.fn('ChatOperations.send')(function* (chat: string, message: OwnerMessage) {
        const { text, operationId, context = {} } = message
        const owner = { harness, applied, routines, subagents, personas, run }
        return yield* attempt(() => run(submitOwner({ ...owner, thread: chat, text, operationId, context })))
      }),
      stop: Effect.fn('ChatOperations.stop')(function* (chat: string, operationId?: string) {
        return yield* attempt(() => run(stopOwner({ ...input.stopping(), thread: chat, operationId })))
      }),
    })
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
  create: Effect.fn('Conversations.create')(function* (input: CreateConversation) {
    const now = yield* nowSecondsEffect
    const { from, topic } = input
    return yield* attempt(() =>
      from === undefined ? conversations.create(now, topic) : conversations.branch(from.conversation, from.entry, now),
    )
  }),
  startThread: Effect.fn('Conversations.startThread')(function* (parent: string, operationId: string) {
    const now = yield* nowSecondsEffect
    return yield* attempt(() => conversations.startThread(parent, operationId, now))
  }),
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

/** The registry's writes into existing chats over the legacy `ConversationRegistry`. */
const registryWrites = (conversations: ConversationRegistry) => ({
  touched: Effect.fn('Conversations.touched')(function* (chats: readonly string[]) {
    return yield* attemptSync(() => conversations.touched(chats))
  }),
  reportRoutine: Effect.fn('Conversations.reportRoutine')(function* (report: RoutineReport) {
    return yield* attempt(() => conversations.reportRoutine(report))
  }),
  shareBack: Effect.fn('Conversations.shareBack')(function* (thread: string, note: string, requestId: string) {
    return yield* attempt(() => conversations.shareBack(thread, note, requestId))
  }),
  announce: Effect.fn('Conversations.announce')(function* (thread: string) {
    return yield* attempt(() => conversations.announce(thread))
  }),
  writeEntry: Effect.fn('Conversations.writeEntry')(function* (chat: string, requestId: string, entry: EntryDraft) {
    const written = yield* attempt(() => conversations.writeEntry(chat, requestId, entry))
    return {
      placed: Effect.map(
        attempt(() => written.placed()),
        Option.fromNullishOr,
      ),
    }
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

/** The registry over the legacy `ConversationRegistry`, reading the time from the Clock as the programs do. */
const ConversationsAdapter = Layer.effect(
  Conversations,
  LegacyConversations.useSync((conversations) =>
    Conversations.of({
      ...registryReads(conversations),
      ...registryChats(conversations),
      ...registryWrites(conversations),
    }),
  ),
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
export const ConversationLive: Layer.Layer<Chats | ChatOperations | Conversations | Moves, never, FoundationServices> =
  Layer.mergeAll(ChatsAdapter, ChatOperationsAdapter, ConversationsAdapter, MovesAdapter)
