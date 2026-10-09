import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { PRIMARY_CHAT } from '@goblin/contracts'
import { and, eq, lt, ne } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Brand from 'effect/Brand'
import { Conflict, NotFound } from '../http/errors.ts'
import { appChatOperations, appConversations } from '../storage/schema.ts'

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

const RETENTION = 30 * 24 * 60 * 60

/** Register a fresh agent's stable primary; a retained or rebound binding is never overwritten. */
export function registerPrimary<RunResult>(db: SQLiteAsyncDatabase<'sync', RunResult>, now: number): void {
  db.insert(appConversations)
    .values({
      chatId: PRIMARY_CHAT,
      piSession: String(ROOT_CONVERSATION_ID),
      role: 'primary',
      kind: 'main',
      createdAt: now,
    })
    .onConflictDoNothing()
    .run()
}

/** Stable application identities over Pi sessions. Locks cover admission only, never model execution or waits. */
export class ChatDirectory<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  readonly #locks = new Map<string, Promise<void>>()
  readonly #listeners = new Set<(chat: ChatId) => void>()

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

  operation(chat: string, op: string): SessionId | undefined {
    const row = this.#db
      .select()
      .from(appChatOperations)
      .where(and(eq(appChatOperations.chatId, chat), eq(appChatOperations.operationId, op)))
      .get()
    return row === undefined ? undefined : SessionId(row.sessionId)
  }

  /** Persist intent before submitting to Pi. Replays keep their first session, even after a rebind. */
  admit(chat: string, op: string, now: number): { session: SessionId; existing: boolean } {
    return this.#db.transaction(() => {
      this.#db
        .delete(appChatOperations)
        .where(and(lt(appChatOperations.admittedAt, now - RETENTION), ne(appChatOperations.operationId, op)))
        .run()
      const previous = this.operation(chat, op)
      if (previous !== undefined) return { session: previous, existing: true }
      const session = this.session(chat)
      this.#db
        .insert(appChatOperations)
        .values({ chatId: chat, operationId: op, sessionId: session, admittedAt: now })
        .run()
      return { session, existing: false }
    })
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

  /** Fence stale movers and preserve the old operation receipts. No production caller yet. */
  rebind(chat: string, expected: { from: string; epoch: number }, to: string, now: number): void {
    this.#db.transaction(() => {
      const owner = this.chatOf(to)
      if (owner !== undefined && owner !== chat) throw new Conflict({ reason: 'session belongs to another chat' })
      const changed = this.#db
        .update(appConversations)
        .set({ piSession: to, epoch: expected.epoch + 1 })
        .where(
          and(
            eq(appConversations.chatId, chat),
            eq(appConversations.piSession, expected.from),
            eq(appConversations.epoch, expected.epoch),
          ),
        )
        .returning()
        .all()
      if (changed.length === 0) throw new Conflict({ reason: 'chat binding changed' })
      this.#db
        .delete(appChatOperations)
        .where(lt(appChatOperations.admittedAt, now - RETENTION))
        .run()
    })
    for (const listener of this.#listeners) listener(ChatId(chat))
  }

  onRebind(listener: (chat: ChatId) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
