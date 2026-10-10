import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { PRIMARY_CHAT } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Brand from 'effect/Brand'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { appConversations } from '../storage/schema.ts'
import { appTopics } from '../storage/topics.ts'
import { receiptIn } from './receipts.ts'

export type ChatId = string & Brand.Brand<'ChatId'>
export const ChatId = Brand.nominal<ChatId>()
export type SessionId = string & Brand.Brand<'SessionId'>
export const SessionId = Brand.nominal<SessionId>()

/** The database the chat rows live in: the agent's SQLite, or a test's. */
export type ChatDb = SQLiteAsyncDatabase<'sync', unknown>

/** The roles of a Topic's one Conversation: Personal's (`primary`, the inbound target) and every other Topic's. */
const channelRoles: ReadonlySet<string> = new Set(['primary', 'conversation'])

/** A chat row to register: its Pi session is its own id unless it says otherwise (ADR 0030). */
export type ChatRow = Omit<typeof appConversations.$inferInsert, 'piSession'> & { readonly piSession?: string }

/** A registered chat's row as stored. */
export type StoredChat = typeof appConversations.$inferSelect

/**
 * The one chat-row inserter: every chat the agent registers goes in here, synchronously, so a caller's transaction
 * holds it. A chat registered already fails the insert, unless `again` is `keep`, which leaves its row as it is. True
 * when this call wrote the row.
 */
export function registerChat<RunResult>(
  db: SQLiteAsyncDatabase<'sync', RunResult>,
  row: ChatRow,
  again: 'fail' | 'keep' = 'fail',
): boolean {
  const insert = db.insert(appConversations).values({ ...row, piSession: row.piSession ?? row.chatId })
  const written =
    again === 'keep'
      ? insert.onConflictDoNothing().returning({ chat: appConversations.chatId }).all()
      : insert.returning({ chat: appConversations.chatId }).all()
  return written.length > 0
}

/** Register a fresh agent's stable primary; a retained or rebound binding is never overwritten. */
export function registerPrimary<RunResult>(db: SQLiteAsyncDatabase<'sync', RunResult>, now: number): void {
  const primary = String(ROOT_CONVERSATION_ID)
  registerChat(db, { chatId: PRIMARY_CHAT, piSession: primary, role: 'primary', kind: 'main', createdAt: now }, 'keep')
}

// Stable application identities over Pi sessions (ADR 0030), read from the agent's SQLite: each read is a function of
// the database, which holds all of the directory's state, so every reader agrees. A chat's admission lock is
// `ChatOperations.withChat` (`KeyedLock`).

/** Personal's Conversation, Main: the inbound target. */
export const primaryChat: ChatId = ChatId(PRIMARY_CHAT)

/** A chat's row, when it is registered: the one read every chat lookup starts from. */
export const chatRow = (db: ChatDb, chat: string): StoredChat | undefined =>
  db.select().from(appConversations).where(eq(appConversations.chatId, chat)).get()

/** A registered chat's row; anything else is `NotFound`. */
const registeredRow = (db: ChatDb, chat: string): StoredChat => {
  const row = chatRow(db, chat)
  if (row === undefined) throw new NotFound({ what: 'chat' })
  return row
}

/** Whether a chat's row is a Topic's one Conversation (a channel): Personal's (`primary`) or another Topic's. */
export const isChannel = (row: Pick<StoredChat, 'role'>): boolean => channelRoles.has(row.role ?? '')

/** The Pi session a registered chat is on now; anything else is `NotFound`. */
export const chatSession = (db: ChatDb, chat: string): SessionId => {
  const row = chatRow(db, chat)
  if (row?.piSession === undefined || row.piSession === null) throw new NotFound({ what: 'chat' })
  return SessionId(row.piSession)
}

/** The chat a Pi session belongs to, if any. */
export const chatOfSession = (db: ChatDb, session: string): ChatId | undefined => {
  const row = db.select().from(appConversations).where(eq(appConversations.piSession, session)).get()
  return row === undefined ? undefined : ChatId(row.chatId)
}

/** Whether a registered chat is a Topic's one Conversation (a channel). */
export const isConversationChat = (db: ChatDb, chat: string): boolean => isChannel(registeredRow(db, chat))

/** Whether `chat` is a Persona's hidden fork (ADR 0033): never listed, never reported on its own. */
export const isHiddenChat = (db: ChatDb, chat: string): boolean => chatRow(db, chat)?.role === 'persona'

/** The Topic a registered chat belongs to. */
export const topicOfChat = (db: ChatDb, chat: string): number => registeredRow(db, chat).topicId

/** A Topic's one Conversation. */
export const conversationOfTopic = (db: ChatDb, topic: number): ChatId => {
  const row = db.select({ chat: appTopics.chatId }).from(appTopics).where(eq(appTopics.id, topic)).get()
  if (row === undefined) throw new NotFound({ what: 'topic' })
  return ChatId(row.chat)
}

/**
 * The Conversation `chat` sits under: itself when it is one, else the nearest one up its parents, else its Topic's.
 * Stored parents that loop end the walk.
 */
export const conversationAbove = (db: ChatDb, chat: string): ChatId => {
  const seen = new Set<string>()
  const start = registeredRow(db, chat)
  let row: StoredChat | undefined = start
  while (row !== undefined && !seen.has(row.chatId)) {
    if (isChannel(row)) return ChatId(row.chatId)
    seen.add(row.chatId)
    row = row.parentSession === null ? undefined : chatRow(db, row.parentSession)
  }
  return conversationOfTopic(db, start.topicId)
}

/**
 * The Pi session of a registered chat that takes new work: open, not a Persona's (ADR 0033), its Topic not archived
 * (ADR 0032). Anything else is refused: `NotFound` when unregistered, else `InvalidInput` with the reason.
 */
export const openChatSession = (db: ChatDb, chat: string): SessionId => {
  const row = chatRow(db, chat)
  if (row === undefined) throw new NotFound({ what: 'conversation' })
  if (row.role === 'persona') throw new InvalidInput({ reason: 'persona_turn' })
  if (row.closedAt !== null) throw new InvalidInput({ reason: 'conversation_closed' })
  const topic = db.select({ at: appTopics.archivedAt }).from(appTopics).where(eq(appTopics.id, row.topicId)).get()
  if (topic === undefined) throw new NotFound({ what: 'topic' })
  if (topic.at !== null) throw new InvalidInput({ reason: 'topic_archived' })
  return chatSession(db, chat)
}

/** The session `op` was admitted to in `chat`, if it was (chats/receipts.ts). */
export const operationSession = (db: ChatDb, chat: string, op: string): SessionId | undefined => {
  const receipt = receiptIn(db, chat, op)
  return receipt === undefined ? undefined : SessionId(receipt.session)
}

/** The directory's reads over one database as an object, for the probes and tests. The services read the functions. */
export class ChatDirectory {
  readonly #db: ChatDb

  constructor(db: ChatDb) {
    this.#db = db
  }

  primary(): ChatId {
    return primaryChat
  }

  session(chat: string): SessionId {
    return chatSession(this.#db, chat)
  }

  chatOf(session: string): ChatId | undefined {
    return chatOfSession(this.#db, session)
  }

  isConversation(chat: string): boolean {
    return isConversationChat(this.#db, chat)
  }

  isHidden(chat: string): boolean {
    return isHiddenChat(this.#db, chat)
  }

  topicOf(chat: string): number {
    return topicOfChat(this.#db, chat)
  }

  conversationOf(topic: number): ChatId {
    return conversationOfTopic(this.#db, topic)
  }

  conversationAbove(chat: string): ChatId {
    return conversationAbove(this.#db, chat)
  }

  requireOpen(chat: string): SessionId {
    return openChatSession(this.#db, chat)
  }

  operation(chat: string, op: string): SessionId | undefined {
    return operationSession(this.#db, chat, op)
  }
}
