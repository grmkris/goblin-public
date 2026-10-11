import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { NotFound, attempt, attemptSync } from '../../http/errors.ts'
import { rememberedThrough } from '../../memory/store.ts'
import { BACKGROUND, conversationId, entryId } from '../../pi/context.ts'
import { Subagents, answerText } from '../../pi/subagent-relay.ts'
import { appConversations } from '../../storage/schema.ts'
import {
  actingChatSession,
  type ChatDb,
  type StoredChat,
  chatOfSession,
  chatRow,
  chatSession,
  conversationAbove,
  isChannel,
  openChatSession,
} from '../directory.ts'
import { subtreeOf } from '../stops.ts'
import { fromPi } from '../../pi/sessions.ts'
import { type RegistryCore, describe, piConversation, registered } from './core.ts'

// The registry's reads (ADR 0030): a chat id resolves to its current Pi session only once it is registered, so no
// request opens a conversation by guessing its number; the owner's views of the chats; and what a thread may recall.

/** Entries in one page of a conversation's history. */
const HISTORY_PAGE = 40

/**
 * How far a thread branched from `from` at `entry` may zoom into the memory of the Conversation above it: that memory
 * as it was there when it branches the Conversation, never further than its parent could; nothing when it never saw
 * one (a subagent, a "+" thread).
 */
export const recallFrom = (db: ChatDb, from: StoredChat, entry: number): number | null => {
  const sizeAt = rememberedThrough(db, conversationAbove(db, from.chatId), entry)
  if (isChannel(from)) return sizeAt
  return from.recallThrough === null ? null : Math.min(from.recallThrough, sizeAt)
}

/** The Pi session of a registered chat; anything else is `NotFound`. */
const requireChat = Effect.fn('Conversations.require')(function* (core: RegistryCore, chat: string) {
  yield* registered(core, chat)
  return yield* attemptSync(() => chatSession(core.db, chat))
})

/** The immutable Pi session holding a subagent's anchor and relays. */
const spawnerOf = Effect.fn('Conversations.spawnerSession')(function* (core: RegistryCore, chat: string) {
  const row = yield* registered(core, chat)
  if (row.kind !== 'subagent' || row.parentSession === null) return yield* new NotFound({ what: 'spawner' })
  return row.spawnerSession ?? (yield* requireChat(core, row.parentSession))
})

/** Every registered chat but Persona forks, oldest first, closed ones included. */
const listChats = (core: RegistryCore) =>
  Effect.suspend(() => {
    const rows = core.db
      .select()
      .from(appConversations)
      .where(sql`${appConversations.role} IS NOT 'persona'`)
      .orderBy(asc(appConversations.createdAt))
      .all()
    return Effect.forEach(rows, (row) => describe(core, row), { concurrency: 'unbounded' })
  }).pipe(Effect.withSpan('Conversations.list'))

/** Latest report the parent received, bounded and labelled as reference data by the composer. */
const helperReference = Effect.fn('Conversations.helperReference')(function* (core: RegistryCore, chat: string) {
  const row = yield* registered(core, chat)
  if (row.kind !== 'subagent' || row.parentSession === null) return yield* new NotFound({ what: 'subagent' })
  const spawner = row.spawnerSession ?? (yield* requireChat(core, row.parentSession))
  const harness = yield* fromPi(core.pi.pi)
  const roster = yield* attempt(() => harness.snapshot(Subagents, conversationId(spawner), BACKGROUND))
  const helper = Object.values(roster?.agents ?? {}).find((agent) => String(agent.conversationId) === chat)
  const at = helper?.reported.at(-1)
  const source = yield* piConversation(core, chat)
  const entries =
    at === undefined
      ? []
      : (yield* attempt(() => source.entries({ minEntryId: at, maxEntryId: at }, 1, undefined, BACKGROUND))).items
  const busy = yield* fromPi(core.pi.busy(yield* requireChat(core, chat)))
  return {
    conversationId: chat,
    label: row.title ?? 'Untitled helper',
    status: busy ? 'Working' : row.closedBy === 'done' ? 'Done' : row.closedAt === null ? 'Idle' : 'Closed',
    report: answerText(entries[0]).slice(0, 8000),
  }
})

/** The open chats of `topic` other than subagents: its Conversation and threads, whose work an archive stops. */
const openIn = (db: ChatDb, topic: number): readonly string[] =>
  db
    .select({ id: appConversations.chatId })
    .from(appConversations)
    .where(
      and(
        eq(appConversations.topicId, topic),
        isNull(appConversations.closedAt),
        ne(appConversations.kind, 'subagent'),
        sql`${appConversations.role} IS NOT 'persona'`,
      ),
    )
    .all()
    .map((row) => row.id)

/**
 * How far `zoom` reaches from `session` into the memory of the Conversation above it (`size` messages): all of it
 * from that Conversation, up to its fork from a thread.
 */
const recallLimit = (db: ChatDb, session: string, size: number): number => {
  const row = chatRow(db, chatOfSession(db, session) ?? '')
  if (row === undefined) return 0
  return isChannel(row) ? size : (row.recallThrough ?? 0)
}

/** A page of a chat's history before entry `before`, oldest first, and whether older entries remain. */
const history = Effect.fn('Conversations.history')(function* (core: RegistryCore, chat: string, before: number) {
  const source = yield* piConversation(core, chat)
  const page = yield* attempt(() =>
    source.entries({ maxEntryId: entryId(before - 1) }, HISTORY_PAGE, undefined, BACKGROUND),
  )
  return { entries: page.items.toReversed(), more: page.next !== undefined }
})

/** The registry's reads over its core, each in its span. */
export const registryReads = (core: RegistryCore) => {
  const { db } = core
  return {
    require: (chat: string) => requireChat(core, chat),
    requireOpen: (chat: string) =>
      attemptSync(() => openChatSession(db, chat)).pipe(Effect.withSpan('Conversations.requireOpen')),
    requireActing: (chat: string) =>
      attemptSync(() => actingChatSession(db, chat)).pipe(Effect.withSpan('Conversations.requireActing')),
    kindOf: (chat: string) =>
      Effect.map(registered(core, chat), (row) => row.kind).pipe(Effect.withSpan('Conversations.kindOf')),
    spawnerSession: (chat: string) => spawnerOf(core, chat),
    view: (chat: string) =>
      Effect.suspend(() => {
        const row = chatRow(db, chat)
        return row === undefined ? Effect.succeedNone : Effect.map(describe(core, row), Option.some)
      }).pipe(Effect.withSpan('Conversations.view')),
    list: listChats(core),
    helperReference: (chat: string) => helperReference(core, chat),
    openIn: (topic: number) => attemptSync(() => openIn(db, topic)).pipe(Effect.withSpan('Conversations.openIn')),
    recallAt: (chat: string, entry: number) =>
      Effect.flatMap(registered(core, chat), (row) => attemptSync(() => recallFrom(db, row, entry))).pipe(
        Effect.withSpan('Conversations.recallAt'),
      ),
    recallLimit: (session: string, size: number) =>
      attemptSync(() => recallLimit(db, session, size)).pipe(Effect.withSpan('Conversations.recallLimit')),
    history: (chat: string, before: number) => history(core, chat, before),
    subtree: (chat: string) => attemptSync(() => subtreeOf(db, chat)).pipe(Effect.withSpan('Conversations.subtree')),
  }
}
