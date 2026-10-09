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
import { type ChatDirectory, SessionId } from '../chats/directory.ts'
import { epochSeconds, instanceCall } from '../chats/instance.ts'
import {
  type ReceiptChange,
  type ReceiptInput,
  admitReceipt,
  advanceReceipt,
  receiptIn,
  relatedReceipts,
} from '../chats/receipts.ts'
import { toAppError } from '../http/errors.ts'
import type { ConversationRegistry } from '../conversations.ts'
import { KeyedLock } from '../observability/lock.ts'
import { type PiFailure, PiSessions } from '../pi/sessions.ts'
import { Db } from '../runtime/db.ts'
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
 * Holds `chat`'s lock on the legacy directory, which its Promise callers (the mover, the registry's own passive writes)
 * still take: admission holds it inside `KeyedLock`'s, so they and the Effect callers stay one at a time per chat. It
 * is held from when its turn comes until the returned release runs. It goes once those callers take `ChatOperations`.
 */
const legacyLock = (chats: ChatDirectory, chat: string) =>
  Effect.callback<() => void>((resume) => {
    chats
      .withChat(chat, () => new Promise<void>((release) => resume(Effect.succeed(() => release()))))
      // expected: the lock's own run never rejects, so neither does its promise.
      .catch(() => undefined)
  })

/** What an admission that does not say what it is records. */
const UNDESCRIBED: ReceiptInput = { kind: 'send', origin: 'system' }

/** A synchronous read or write of the receipts, its throw a typed `AppError` (`NotFound` for an unknown chat). */
const sql = <A>(run: () => A) => Effect.try({ try: run, catch: toAppError })

/** A Pi call's failure as the programs take one: Pi's own error through `toAppError`. */
const piFailure = (failure: PiFailure) => Effect.fail(toAppError(failure.cause))

/**
 * Admission natively: receipts in the agent's SQLite (chats/receipts.ts), the chat's lock in `KeyedLock`, Pi's writes
 * through `PiSessions`. The chat's current session comes from the one chat directory, whose lock admission also holds
 * (`legacyLock`). The owner's send and Stop read services of lanes whose layers come after this one, so they run their
 * programs through the bridge until the layers are ordered for them (status.md, wave 3).
 */
export const ChatOperationsLive = Layer.effect(
  ChatOperations,
  Effect.gen(function* () {
    const db = yield* Db
    const locks = yield* KeyedLock
    const pi = yield* PiSessions
    const chats = yield* LegacyChats
    const input = yield* AgentInput
    const { harness, applied, routines, subagents, personas, run } = input
    const withChat = <A, E, R>(chat: string, effect: Effect.Effect<A, E, R>) =>
      locks
        .withLock(`chat:${chat}`)(
          Effect.acquireUseRelease(
            legacyLock(chats, chat),
            () => effect,
            (release) => Effect.sync(release),
          ),
        )
        .pipe(Effect.withSpan('ChatOperations.withChat'))
    const admit = Effect.fn('ChatOperations.admit')(function* (
      chat: string,
      operationId: string,
      receipt: ReceiptInput = UNDESCRIBED,
    ) {
      const now = yield* epochSeconds
      const admitted = yield* sql(() =>
        admitReceipt(db, { chat, operationId, receipt, session: () => chats.session(chat), now }),
      )
      return { session: SessionId(admitted.session), existing: admitted.existing }
    })
    const written = Effect.fn('ChatOperations.written')(function* (chat: string, write: PassiveWrite) {
      const { requestId, entry, origin = 'system', parentOp } = write
      const receipt = { kind: `write:${entry.kind}`, origin, ...(parentOp === undefined ? {} : { parentOp }) } as const
      const { session } = yield* admit(chat, requestId, receipt)
      const submission = yield* pi.write(session, { requestId, entry }).pipe(Effect.catchTag('PiFailure', piFailure))
      const now = yield* epochSeconds
      yield* sql(() => advanceReceipt(db, chat, requestId, { state: 'written', now }))
      return submission
    })
    return ChatOperations.of({
      admit,
      operation: Effect.fn('ChatOperations.operation')(function* (chat: string, operationId: string) {
        return Option.map(Option.fromNullishOr(yield* sql(() => receiptIn(db, chat, operationId))), (found) =>
          SessionId(found.session),
        )
      }),
      receipt: Effect.fn('ChatOperations.receipt')(function* (chat: string, operationId: string) {
        return Option.fromNullishOr(yield* sql(() => receiptIn(db, chat, operationId)))
      }),
      related: Effect.fn('ChatOperations.related')(function* (operationId: string) {
        return yield* sql(() => relatedReceipts(db, operationId))
      }),
      advance: Effect.fn('ChatOperations.advance')(function* (
        chat: string,
        operationId: string,
        change: Omit<ReceiptChange, 'now'>,
      ) {
        const now = yield* epochSeconds
        yield* sql(() => advanceReceipt(db, chat, operationId, { ...change, now }))
      }),
      withChat,
      passiveWrite: (chat, write) => withChat(chat, written(chat, write)),
      send: Effect.fn('ChatOperations.send')(function* (chat: string, message: OwnerMessage) {
        const { text, operationId, context = {} } = message
        const owner = { harness, applied, routines, subagents, personas, run }
        return yield* instanceCall(() => run(submitOwner({ ...owner, thread: chat, text, operationId, context })))
      }),
      stop: Effect.fn('ChatOperations.stop')(function* (chat: string, operationId?: string) {
        return yield* instanceCall(() => run(stopOwner({ ...input.stopping(), thread: chat, operationId })))
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
  Layer.mergeAll(ChatsAdapter, ChatOperationsLive, ConversationsAdapter, MovesAdapter)
