import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { PRIMARY_CHAT } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Brand from 'effect/Brand'
import { NotFound } from '../http/errors.ts'
import { appConversations } from '../storage/schema.ts'
import { appTopics } from '../storage/topics.ts'
import { receiptIn } from './receipts.ts'

export type ChatId = string & Brand.Brand<'ChatId'>
export const ChatId = Brand.nominal<ChatId>()
export type SessionId = string & Brand.Brand<'SessionId'>
export const SessionId = Brand.nominal<SessionId>()

const noop = (): void => undefined

const deferred = (): { readonly promise: Promise<void>; readonly release: () => void } => {
  let resolvePromise = noop
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, release: resolvePromise }
}

/** The roles of a Topic's one Conversation: Personal's (`primary`, the inbound target) and every other Topic's. */
const channelRoles: ReadonlySet<string> = new Set(['primary', 'conversation'])

/** A chat row to register: its Pi session is its own id unless it says otherwise (ADR 0030). */
export type ChatRow = Omit<typeof appConversations.$inferInsert, 'piSession'> & { readonly piSession?: string }

/**
 * The one chat-row inserter (plan §3): every chat the agent registers goes in here, synchronously, so a caller's
 * transaction holds it. A chat registered already fails the insert, unless `again` is `keep`, which leaves its row as
 * it is. True when this call wrote the row.
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

/** Stable application identities over Pi sessions. Locks cover admission only, never model execution or waits. */
export class ChatDirectory<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  readonly #locks = new Map<string, Promise<void>>()

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>) {
    this.#db = db
  }

  primary(): ChatId {
    return ChatId(PRIMARY_CHAT)
  }

  session(chat: string): SessionId {
    const row = this.#db.select().from(appConversations).where(eq(appConversations.chatId, chat)).get()
    if (row?.piSession === undefined || row.piSession === null) throw new NotFound({ what: 'chat' })
    return SessionId(row.piSession)
  }

  chatOf(session: string): ChatId | undefined {
    const row = this.#db.select().from(appConversations).where(eq(appConversations.piSession, session)).get()
    return row === undefined ? undefined : ChatId(row.chatId)
  }

  #find(chat: string) {
    return this.#db.select().from(appConversations).where(eq(appConversations.chatId, chat)).get()
  }

  #row(chat: string) {
    const row = this.#find(chat)
    if (row === undefined) throw new NotFound({ what: 'chat' })
    return row
  }

  /** Whether `chat` is a Topic's one Conversation (a channel): Personal's (`primary`) or another Topic's. */
  isConversation(chat: string): boolean {
    return channelRoles.has(this.#row(chat).role ?? '')
  }

  /** Whether `chat` is a Persona's hidden fork (ADR 0033): never listed, never reported on its own. */
  isHidden(chat: string): boolean {
    return this.#find(chat)?.role === 'persona'
  }

  /** The Topic a registered chat belongs to. */
  topicOf(chat: string): number {
    return this.#row(chat).topicId
  }

  /** A Topic's one Conversation. */
  conversationOf(topic: number): ChatId {
    const row = this.#db.select({ chat: appTopics.chatId }).from(appTopics).where(eq(appTopics.id, topic)).get()
    if (row === undefined) throw new NotFound({ what: 'topic' })
    return ChatId(row.chat)
  }

  /**
   * The Conversation `chat` sits under: itself when it is one, else the nearest one up its parents, else its Topic's.
   * Stored parents that loop end the walk.
   */
  conversationAbove(chat: string): ChatId {
    const seen = new Set<string>()
    const start = this.#row(chat)
    let row: typeof start | undefined = start
    while (row !== undefined && !seen.has(row.chatId)) {
      if (channelRoles.has(row.role ?? '')) return ChatId(row.chatId)
      seen.add(row.chatId)
      row = row.parentSession === null ? undefined : this.#find(row.parentSession)
    }
    return this.conversationOf(start.topicId)
  }

  /** The session `op` was admitted to in `chat`, if it was (chats/receipts.ts). */
  operation(chat: string, op: string): SessionId | undefined {
    const receipt = receiptIn(this.#db, chat, op)
    return receipt === undefined ? undefined : SessionId(receipt.session)
  }

  async withChat<A>(chat: string, run: () => Promise<A>): Promise<A> {
    const previous = this.#locks.get(chat)
    const { promise: lock, release } = deferred()
    this.#locks.set(chat, lock)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.#locks.get(chat) === lock) this.#locks.delete(chat)
    }
  }

  /** Resolve a chat and submit one passive write while admission for that chat is locked. */
  async passiveWrite<A>(chat: string, run: (session: SessionId) => Promise<A>): Promise<A> {
    return this.withChat(chat, async () => run(this.session(chat)))
  }
}
