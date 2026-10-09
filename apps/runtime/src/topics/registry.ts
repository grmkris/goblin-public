import {
  type CreateTopic,
  PERSONAL_TOPIC,
  type TopicSeedData,
  type TopicView,
  type UpdateTopic,
} from '@goblin/contracts'
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { Conflict, InvalidInput, NotFound } from '../http/errors.ts'
import { appTopics } from '../storage/topics.ts'

type Row = typeof appTopics.$inferSelect

/** Who made a Topic: the owner (UI) or the agent (its organize tools, on a direct request). */
export type TopicActor = 'owner' | 'agent'

/**
 * What a new Topic's Conversation needs beyond this table, injected so the registry is tested without Pi: `open` makes
 * a new Pi session configured like Personal's Conversation (never a fork of it) and returns its id; `register` lists
 * it in the chat registry as the Topic's Conversation, inside the registry's transaction; `activate` turns its memory
 * on (once; repeating it does nothing); `retitle` keeps the Conversation's title the Topic's name.
 */
export type TopicPorts = {
  readonly open: () => Promise<string>
  readonly register: (chat: string, topic: number, name: string, now: number) => void
  readonly activate: (chat: string) => Promise<void>
  readonly retitle: (chat: string, name: string) => void
  /** Writes a Topic's seed into its Conversation once per operation (a passive write; it starts no run). */
  readonly seed: (chat: string, operationId: string, seed: TopicSeedData) => Promise<void>
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
 * The owner's Topics (ADR 0032). Personal (id 1) is seeded by the migration with Main as its Conversation; every other
 * Topic gets a new Pi session as its Conversation when it is created. Creating is idempotent by operation id and
 * serialized in the isolate, so a retry or a concurrent repeat finds the one Topic and its one Pi session. Archive here
 * only marks the Topic; stopping its chats' work is the caller's (`topics/program.ts`), through the existing Stop paths.
 */
export class TopicRegistry<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  readonly #ports: TopicPorts
  readonly #listeners = new Set<(topics: readonly TopicView[]) => void>()
  #creating: Promise<unknown> = Promise.resolve()

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>, ports: TopicPorts) {
    this.#db = db
    this.#ports = ports
  }

  /** Calls `listener` with the Topics each write changed; returns what unsubscribes it. */
  onChange(listener: (topics: readonly TopicView[]) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #changed(rows: readonly Row[]): void {
    if (rows.length === 0) return
    const topics = rows.map(view)
    for (const listener of this.#listeners) listener(topics)
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
   * (the organize tools) starts with `seed`, its brief and frozen excerpts, as an `app.topic_seed` entry.
   */
  async create(
    input: CreateTopic,
    actor: TopicActor,
    now: number,
    seed?: TopicSeedData,
  ): Promise<{ topic: TopicView; created: boolean }> {
    const run = this.#creating.then(async () => this.#create(input, actor, now, seed))
    // expected: this create's caller gets its failure from `run`; the queue only waits for it to settle.
    this.#creating = run.catch(() => undefined)
    return run
  }

  async #create(
    input: CreateTopic,
    actor: TopicActor,
    now: number,
    seed: TopicSeedData | undefined,
  ): Promise<{ topic: TopicView; created: boolean }> {
    const existing = this.#db.select().from(appTopics).where(eq(appTopics.operationId, input.operationId)).get()
    if (existing !== undefined) {
      // A retry finishes what a failed first attempt began: the Conversation's memory and its seed.
      await this.#ready(existing.chatId, input.operationId, seed)
      return { topic: view(existing), created: false }
    }
    const name = cleanName(input.name)
    this.#assertFree(name)
    const chat = await this.#ports.open()
    const row = this.#db.transaction(() => {
      this.#assertFree(name)
      const [inserted] = this.#db
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
      this.#ports.register(chat, inserted.id, name, now)
      return inserted
    })
    this.#changed([row])
    await this.#ready(chat, input.operationId, seed)
    return { topic: view(row), created: true }
  }

  /** Turns the new Conversation's memory on, then writes the seed it was made with, if any; both are idempotent. */
  async #ready(chat: string, operationId: string, seed: TopicSeedData | undefined): Promise<void> {
    await this.#ports.activate(chat)
    if (seed !== undefined) await this.#ports.seed(chat, operationId, seed)
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
    this.#changed([updated])
    return view(updated)
  }
}
