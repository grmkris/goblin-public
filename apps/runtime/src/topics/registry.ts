import {
  type CreateTopic,
  PERSONAL_TOPIC,
  type TopicSeedData,
  type TopicView,
  type UpdateTopic,
} from '@goblin/contracts'
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Effect from 'effect/Effect'
import { type AppError, Conflict, InvalidInput, NotFound, attemptSync } from '../http/errors.ts'
import { appTopics } from '../storage/topics.ts'

type Row = typeof appTopics.$inferSelect

/** Who made a Topic: the owner (UI) or the agent (its organize tools, on a direct request). */
export type TopicActor = 'owner' | 'agent'

/**
 * What a new Topic's Conversation needs beyond this table, injected so the registry is tested without Pi: `open` makes
 * a new Pi session configured like Personal's Conversation (never a fork of it) and answers its id; `register` lists
 * it in the chat registry as the Topic's Conversation, and `retitle` keeps its title the Topic's name, each inside the
 * registry's transaction; `touched` tells the conversations' listeners about a Conversation either wrote, after it;
 * `activate` turns its memory on (once; repeating it does nothing).
 */
export type TopicPorts = {
  readonly open: Effect.Effect<string, AppError>
  readonly register: (chat: string, topic: number, name: string, now: number) => void
  readonly retitle: (chat: string, name: string) => void
  readonly touched: (chats: readonly string[]) => Effect.Effect<void, AppError>
  readonly activate: (chat: string) => Effect.Effect<void, AppError>
  /** Writes a Topic's seed into its Conversation once per operation (a passive write; it starts no run). */
  readonly seed: (chat: string, operationId: string, seed: TopicSeedData) => Effect.Effect<void, AppError>
}

const view = (row: Row): TopicView => ({
  id: row.id,
  name: row.name,
  conversation: row.chatId,
  ...(row.id === PERSONAL_TOPIC ? { personal: true } : {}),
  ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
  searchExcluded: row.searchExcluded,
  revision: row.revision,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
})

/** A name as stored: runs of whitespace become one space, ends trimmed; nothing left is refused. */
const cleanName = (name: string): string => {
  const clean = name.replaceAll(/\s+/gu, ' ').trim()
  if (clean === '') throw new InvalidInput({ reason: 'topic_name' })
  return clean
}

/**
 * The owner's Topics (ADR 0032), as rows: a store with no state of its own. Personal (id 1) is seeded by the migration
 * with Main as its Conversation; every other Topic gets a new Pi session as its Conversation when it is created.
 * Creating is idempotent by operation id; the Topics service serializes it (`topics/service.ts`), so a concurrent repeat
 * finds the one Topic and its one Pi session, and tells the change bus what each write changed. Archive here only marks
 * the Topic; stopping its chats' work is the caller's (`topics/program.ts`), through the owner's Stop.
 */
export class TopicRegistry<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  readonly #ports: TopicPorts

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>, ports: TopicPorts) {
    this.#db = db
    this.#ports = ports
  }

  #row(id: number): Row {
    const row = this.#db.select().from(appTopics).where(eq(appTopics.id, id)).get()
    if (row === undefined) throw new NotFound({ what: 'topic' })
    return row
  }

  /** Every Topic, archived ones included, in creation order (Personal first). */
  list(): readonly TopicView[] {
    return this.#db.select().from(appTopics).orderBy(asc(appTopics.id)).all().map(view)
  }

  get(id: number): TopicView {
    return view(this.#row(id))
  }

  /** Whether the Topic is archived: its chats take no new work until it is restored. */
  archived(id: number): boolean {
    return this.#row(id).archivedAt !== null
  }

  /** Refuses `name` while another active Topic has it, ignoring case. */
  #assertFree(name: string, except?: number): void {
    const clash = this.#db
      .select({ id: appTopics.id })
      .from(appTopics)
      .where(
        and(
          sql`${appTopics.name} = ${name} COLLATE NOCASE`,
          isNull(appTopics.archivedAt),
          ...(except === undefined ? [] : [ne(appTopics.id, except)]),
        ),
      )
      .get()
    if (clash !== undefined) throw new Conflict({ reason: 'topic_name_taken' })
  }

  /**
   * A new Topic named `name` with a new Conversation, or the Topic `operationId` already made (whatever its name now).
   * The name is checked before the Pi session is made, so a clash leaves nothing behind. A Topic made from a discussion
   * (the organize tools) starts with `seed`, its brief and frozen excerpts, as an `app.topic_seed` entry. Two creates
   * at once are the caller's to serialize: each would make a Pi session before the other's row exists.
   */
  create(
    input: CreateTopic,
    actor: TopicActor,
    now: number,
    seed?: TopicSeedData,
  ): Effect.Effect<{ readonly topic: TopicView; readonly created: boolean }, AppError> {
    const db = this.#db
    const ports = this.#ports
    const assertFree = (name: string) => this.#assertFree(name)
    /** Turns the Conversation's memory on, then writes the seed it was made with, if any; both are idempotent. */
    const ready = (chat: string) =>
      Effect.andThen(ports.activate(chat), seed === undefined ? Effect.void : ports.seed(chat, input.operationId, seed))
    return Effect.gen(function* () {
      const existing = db.select().from(appTopics).where(eq(appTopics.operationId, input.operationId)).get()
      if (existing !== undefined) {
        // A retry finishes what a failed first attempt began: the Conversation's memory and its seed.
        yield* ready(existing.chatId)
        return { topic: view(existing), created: false }
      }
      const name = yield* attemptSync(() => {
        const clean = cleanName(input.name)
        assertFree(clean)
        return clean
      })
      const chat = yield* ports.open
      const row = yield* attemptSync(() =>
        db.transaction(() => {
          assertFree(name)
          const [inserted] = db
            .insert(appTopics)
            .values({
              name,
              chatId: chat,
              operationId: input.operationId,
              createdBy: actor,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .all()
          if (inserted === undefined) throw new Conflict({ reason: 'topic_not_created' })
          ports.register(chat, inserted.id, name, now)
          return inserted
        }),
      )
      yield* ports.touched([chat])
      yield* ready(chat)
      return { topic: view(row), created: true }
    })
  }

  /** Tells the conversations' listeners that `update` retitled a Topic's Conversation. */
  retitled(chat: string): Effect.Effect<void, AppError> {
    return this.#ports.touched([chat])
  }

  /**
   * Rename, archive or restore, and opt in or out of automatic search, as one change with one new revision. Personal is
   * never archived; a rename or restore onto a name another active Topic has is a `Conflict`. Nothing changed is no
   * write.
   */
  update(id: number, change: UpdateTopic, now: number): TopicView {
    const row = this.#row(id)
    if (change.archived === true && id === PERSONAL_TOPIC) throw new InvalidInput({ reason: 'personal_topic' })
    const name = change.name === undefined ? row.name : cleanName(change.name)
    const archivedAt = change.archived === undefined ? row.archivedAt : change.archived ? (row.archivedAt ?? now) : null
    const searchExcluded = change.searchExcluded ?? row.searchExcluded
    if (name === row.name && archivedAt === row.archivedAt && searchExcluded === row.searchExcluded) return view(row)
    const updated = this.#db.transaction(() => {
      if (archivedAt === null) this.#assertFree(name, id)
      const [next] = this.#db
        .update(appTopics)
        .set({ name, archivedAt, searchExcluded, revision: row.revision + 1, updatedAt: now })
        .where(eq(appTopics.id, id))
        .returning()
        .all()
      if (next === undefined) throw new NotFound({ what: 'topic' })
      if (name !== row.name) this.#ports.retitle(row.chatId, name)
      return next
    })
    return view(updated)
  }
}
