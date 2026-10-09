import type { EntryRecord } from '@earendil-works/pi-durable'
import { RetrievalSource, type SourceUse } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import { and, count, desc, eq, gte, ne, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import { BACKGROUND, conversationId, entryId } from '../pi/context.ts'
import { appConversations } from '../storage/schema.ts'
import { appRetrievalUses, appTranscriptExcerpts, appTranscriptIndex } from '../storage/retrieval.ts'
import { type Range, excerptOf, ftsQuery, indexable, mergeRanges } from './text.ts'
import { searchHits, topicByName, rangeEdge, sourceRows, chatsToIndex, type Hit } from './sql.ts'

/** Where the index reads Pi from, injected so the index is tested without Pi. */
export type TranscriptSource = {
  /** The newest entry id in the session's history (inherited ones included), or none when it is empty or unknown. */
  readonly newest: (session: string) => Promise<number | undefined>
  /** The session's fork-aware entries with ids from `from` through `to`, in any order. */
  readonly entries: (session: string, from: number, to: number) => Promise<readonly EntryRecord[]>
  /** The session's newest `limit` entries, newest first. */
  readonly recent: (session: string, limit: number) => Promise<readonly EntryRecord[]>
}

/** {@link TranscriptSource} over the agent's Pi, through its public Conversation API. */
export function piTranscripts(harness: PiHarness): TranscriptSource {
  const conversation = async (session: string) => (await harness.pi()).conversation(conversationId(session), BACKGROUND)
  const recent = async (session: string, limit: number) => {
    const found = await conversation(session)
    return found === undefined ? [] : (await found.entries({}, limit, undefined, BACKGROUND)).items
  }
  return {
    newest: async (session) => (await recent(session, 1))[0]?.id,
    recent,
    entries: async (session, from, to) => {
      const found = await conversation(session)
      if (found === undefined) return []
      const entries: EntryRecord[] = []
      let cursor: Parameters<typeof found.entries>[2]
      do {
        const page = await found.entries(
          { minEntryId: entryId(from), maxEntryId: entryId(to) },
          100,
          cursor,
          BACKGROUND,
        )
        entries.push(...page.items)
        cursor = page.next
      } while (cursor !== undefined)
      return entries
    },
  }
}

/** Entry ids read per window: Pi ids are global, so a window holds at most this many of one session's entries. */
const WINDOW = 500
/** Windows one catch-up reads at most, so a long history is indexed over several calls. */
const WINDOWS = 40
/** Hits ranked before grouping, and the neighbours on each side a hit's range takes. */
const HITS = 20
const NEIGHBOURS = 2

/** Where a search looks: every chat but `exclude` in the default Topics, or only in `topic` when one is named. */
export type SearchScope = { readonly exclude?: string; readonly topic?: number; readonly limit: number }

/** A use as recorded: its stable id, where it happened and what it found. */
export type UseRecord = Omit<SourceUse, 'chat'> & { readonly chat: string; readonly session: string }

/** A use the index has just written is not there to read back: the record table is not what the index made it. */
class UseNotRecorded extends Schema.TaggedError<UseNotRecorded>()('UseNotRecorded', {}) {}

const decodeSources = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(RetrievalSource)))
const encodeSources = Schema.encodeSync(Schema.fromJsonString(Schema.Array(RetrievalSource)))

/**
 * The owner's transcripts as a full-text index (ADR 0035): an FTS5 (unicode61, bm25) external-content table over one
 * bounded, redacted excerpt per indexed entry. Each Pi session is read through Pi's API in id windows from where it
 * stopped, and only entries the session owns are kept, so fork-inherited history is indexed once, under its own chat.
 * Persona forks are never indexed. Writes are short synchronous transactions; nothing is held across Pi reads. A
 * session's catch-ups must not overlap: the Retrieval service runs each under that session's turn of the agent's
 * KeyedLock (`retrieval/service.ts`).
 */
export class TranscriptIndex<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  readonly #source: TranscriptSource
  readonly #now: () => number

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>, source: TranscriptSource, now: () => number) {
    this.#db = db
    this.#source = source
    this.#now = now
  }

  /**
   * Indexes the session's own entries after its progress mark, reading at most about `maxEntries` of them: `more` when
   * it stopped before the session's newest entry, and how many it read. An unregistered session or a persona fork
   * indexes nothing. Never two at once for one session (see the class).
   */
  async catchUp(session: string, maxEntries: number): Promise<{ readonly more: boolean; readonly read: number }> {
    const chat = this.chatFor(session)
    if (chat === undefined || chat.persona) return { more: false, read: 0 }
    const newest = await this.#source.newest(session)
    // A session's own entries all have ids above its own: Pi mints conversation and entry ids from one sequence.
    let through = this.#through(session) ?? Number(session)
    if (newest === undefined || through >= newest) {
      this.#mark(session, through)
      return { more: false, read: 0 }
    }
    let read = 0
    for (let window = 0; window < WINDOWS && through < newest && read < maxEntries; window += 1) {
      const upper = Math.min(through + WINDOW, newest)
      const owned = (await this.#source.entries(session, through + 1, upper)).filter(
        (entry) => String(entry.conversationId) === session,
      )
      this.#write(session, chat.chat, owned, upper)
      read += owned.length
      through = upper
    }
    return { more: through < newest, read }
  }

  #mark(session: string, through: number): void {
    this.#db
      .insert(appTranscriptIndex)
      .values({ sessionId: session, throughEntry: through, checkedAt: this.#now() })
      .onConflictDoUpdate({ target: appTranscriptIndex.sessionId, set: { checkedAt: this.#now() } })
      .run()
  }

  /** One window's excerpts and the new progress mark, in one short transaction. */
  #write(session: string, chat: string, entries: readonly EntryRecord[], through: number): void {
    const now = this.#now()
    const rows = entries.flatMap((entry) => {
      const kept = indexable(entry, now)
      return kept === undefined
        ? []
        : [{ entryId: entry.id, sessionId: session, chatId: chat, ...kept, author: kept.author ?? null }]
    })
    this.#db.transaction((tx) => {
      for (const row of rows) tx.insert(appTranscriptExcerpts).values(row).onConflictDoNothing().run()
      tx.insert(appTranscriptIndex)
        .values({ sessionId: session, throughEntry: through, checkedAt: now })
        .onConflictDoUpdate({ target: appTranscriptIndex.sessionId, set: { throughEntry: through, checkedAt: now } })
        .run()
    })
  }

  /**
   * The sessions a catch-up of every chat visits, stalest first: open chats, and closed ones not read since they
   * closed.
   */
  toIndex(): readonly string[] {
    return chatsToIndex(this.#db)
  }

  #through(session: string): number | undefined {
    return this.#db.select().from(appTranscriptIndex).where(eq(appTranscriptIndex.sessionId, session)).get()
      ?.throughEntry
  }

  /** How many excerpts the index holds (bm25 magnitudes grow with it). */
  size(): number {
    return this.#db.select({ n: count() }).from(appTranscriptExcerpts).get()?.n ?? 0
  }

  /** The chat a session is registered as and whether it may retrieve automatically (never a persona fork). */
  chatFor(session: string): { readonly chat: string; readonly persona: boolean } | undefined {
    const row = this.#db
      .select({ chat: appConversations.chatId, role: appConversations.role })
      .from(appConversations)
      .where(eq(appConversations.piSession, session))
      .get()
    return row === undefined ? undefined : { chat: row.chat, persona: row.role === 'persona' }
  }

  /**
   * The newest owner input of the session among its last 100 entries (a long tool loop included), with its id and
   * indexed text (bounded and redacted); none when they hold no input with text.
   */
  async latestInput(session: string): Promise<{ readonly entry: number; readonly text: string } | undefined> {
    const input = (await this.#source.recent(session, 100)).find((entry) => entry.kind === 'pi.user')
    const kept = input === undefined ? undefined : indexable(input, this.#now())
    return input === undefined || kept === undefined ? undefined : { entry: input.id, text: kept.text }
  }

  /** Entries of `session` from `fromEntry` on now belong to `chat` (a Move to a thread). */
  reassign(session: string, fromEntry: number, chat: string): void {
    this.#db
      .update(appTranscriptExcerpts)
      .set({ chatId: chat })
      .where(and(eq(appTranscriptExcerpts.sessionId, session), gte(appTranscriptExcerpts.entryId, fromEntry)))
      .run()
  }

  /** The Topic a name or id refers to, archived ones included (a named Topic is searched whatever its state). */
  topicNamed(name: string): number | undefined {
    return topicByName(this.#db, name)
  }

  /**
   * The best matches for `query` as sources: the top bm25 hits grouped into ±2-entry ranges per chat, at most
   * `scope.limit` ranges, each with a quoted excerpt of at most 1,200 characters. Lower scores are better.
   */
  search(query: string, scope: SearchScope): readonly RetrievalSource[] {
    const match = ftsQuery(query)
    if (match === '') return []
    const hits = searchHits(this.#db, match, scope, HITS)
    const ranges: Range[] = hits.map((hit) => ({
      chat: hit.chat,
      start: rangeEdge(this.#db, hit, 'before', NEIGHBOURS),
      end: rangeEdge(this.#db, hit, 'after', NEIGHBOURS),
      score: hit.score,
    }))
    const at = this.#now()
    return mergeRanges(ranges, scope.limit).flatMap((range) => this.#sourceOf(range, hits, at))
  }

  #sourceOf(range: Range, hits: readonly Hit[], at: number): readonly RetrievalSource[] {
    const found = sourceRows(this.#db, range)
    if (found === undefined) return []
    const inside = new Set(
      hits.filter((hit) => hit.chat === range.chat && hit.entryId >= range.start && hit.entryId <= range.end),
    )
    const excerpt = excerptOf(found.rows, new Set([...inside].map((hit) => hit.entryId)))
    return [
      {
        topic: found.topic,
        topicName: found.topicName,
        chat: range.chat,
        ...(found.title === null ? {} : { chatTitle: found.title }),
        entryStart: range.start,
        entryEnd: range.end,
        excerpt,
        retrievedAt: at,
        score: range.score,
      },
    ]
  }

  /**
   * Records what a run used under its stable id, once: a repeat (a replayed tool, a retried request) finds the first
   * record, which is what it returns. Excerpts are stored as captured (frozen evidence).
   */
  record(use: UseRecord): SourceUse {
    this.#db
      .insert(appRetrievalUses)
      .values({
        id: use.id,
        chatId: use.chat,
        sessionId: use.session,
        inputEntry: use.inputEntry ?? null,
        mode: use.mode,
        sources: encodeSources(use.sources),
        retrievedAt: use.retrievedAt,
      })
      .onConflictDoNothing()
      .run()
    const stored = this.recorded(use.id)
    if (stored === undefined) throw new UseNotRecorded()
    return stored
  }

  /** The use recorded under `id`, if any. */
  recorded(id: string): SourceUse | undefined {
    const row = this.#db.select().from(appRetrievalUses).where(eq(appRetrievalUses.id, id)).get()
    return row === undefined ? undefined : useOf(row)
  }

  /**
   * The chat's recorded uses that found something, newest first, at most `limit`: what its answers' source strips show.
   * A search that found nothing stays recorded (its replay is the same empty result) but has no strip.
   */
  uses(chat: string, limit = 100): readonly SourceUse[] {
    return this.#db
      .select()
      .from(appRetrievalUses)
      .where(and(eq(appRetrievalUses.chatId, chat), ne(appRetrievalUses.sources, '[]')))
      .orderBy(desc(appRetrievalUses.retrievedAt), desc(sql`rowid`))
      .limit(limit)
      .all()
      .map(useOf)
  }
}

function useOf(row: typeof appRetrievalUses.$inferSelect): SourceUse {
  return {
    id: row.id,
    chat: row.chatId,
    ...(row.inputEntry === null ? {} : { inputEntry: row.inputEntry }),
    mode: row.mode,
    sources: decodeSources(row.sources),
    retrievedAt: row.retrievedAt,
  }
}

/**
 * Cross-Topic retrieval's one transcript index (ADR 0035), made at the start (`layers/knowledge.ts`): retrieval reads it
 * and a Move to thread reassigns its rows (ADR 0034).
 */
export class TranscriptsInstance extends Context.Service<TranscriptsInstance, TranscriptIndex>()(
  'goblin/retrieval/TranscriptsInstance',
) {}
