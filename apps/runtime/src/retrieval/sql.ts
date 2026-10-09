import { sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Schema from 'effect/Schema'
import type { ExcerptRow, Range } from './text.ts'

/** The raw SQL of the transcript index (ADR 0035): FTS5 MATCH and bm25 have no Drizzle builder. */
type Db<RunResult> = SQLiteAsyncDatabase<'sync', RunResult>

/** One FTS hit: the entry, its chat and its bm25 score (lower is better). */
export type Hit = { readonly entryId: number; readonly chat: string; readonly score: number }

const Hits = Schema.Array(Schema.Struct({ entryId: Schema.Number, chat: Schema.String, score: Schema.Number }))
const Edge = Schema.Struct({ edge: Schema.NullOr(Schema.Number) })
const Rows = Schema.Array(
  Schema.Struct({
    entryId: Schema.Number,
    role: Schema.String,
    author: Schema.NullOr(Schema.String),
    text: Schema.String,
  }),
)
const Place = Schema.Struct({ topic: Schema.Number, topicName: Schema.String, title: Schema.NullOr(Schema.String) })
const Ids = Schema.Array(Schema.Struct({ id: Schema.Number }))
const Sessions = Schema.Array(Schema.Struct({ session: Schema.String }))

/**
 * The best `limit` hits for an FTS5 `match` (built by `ftsQuery`, so it is literal terms only), never in a persona
 * fork or the excluded chat. Without a named Topic only active Topics that take part in search are searched; a named
 * Topic is searched alone, whatever its state (a deliberate request overrides archive and opt-out).
 */
export function searchHits<R>(
  db: Db<R>,
  match: string,
  scope: { readonly exclude?: string; readonly topic?: number },
  limit: number,
): readonly Hit[] {
  const topics =
    scope.topic === undefined ? sql`t.archived_at IS NULL AND t.search_excluded = 0` : sql`t.id = ${scope.topic}`
  const rows = db.all(sql`
    SELECT e.entry_id AS entryId, e.chat_id AS chat, bm25(app_transcript_fts) AS score
    FROM app_transcript_fts
    JOIN app_transcript_excerpts e ON e.entry_id = app_transcript_fts.rowid
    JOIN app_conversations c ON c.session_id = e.chat_id
    JOIN app_topics t ON t.id = c.topic_id
    WHERE app_transcript_fts MATCH ${match}
      AND (c.role IS NULL OR c.role <> 'persona')
      AND e.chat_id <> ${scope.exclude ?? ''}
      AND ${topics}
    ORDER BY score ASC, e.at DESC, e.entry_id DESC
    LIMIT ${limit}`)
  return Schema.decodeUnknownSync(Hits)(rows)
}

/** The first (`before`) or last (`after`) entry of the `n` indexed entries on that side of a hit, in its chat. */
export function rangeEdge<R>(db: Db<R>, hit: Hit, side: 'before' | 'after', n: number): number {
  const query =
    side === 'before'
      ? sql`SELECT min(entry_id) AS edge FROM (SELECT entry_id FROM app_transcript_excerpts
          WHERE chat_id = ${hit.chat} AND entry_id <= ${hit.entryId} ORDER BY entry_id DESC LIMIT ${n + 1})`
      : sql`SELECT max(entry_id) AS edge FROM (SELECT entry_id FROM app_transcript_excerpts
          WHERE chat_id = ${hit.chat} AND entry_id >= ${hit.entryId} ORDER BY entry_id ASC LIMIT ${n + 1})`
  // `all`, never `get`: the Durable Object driver's `get` throws on an empty result.
  return Schema.decodeUnknownSync(Schema.Array(Edge))(db.all(query))[0]?.edge ?? hit.entryId
}

/** A range's excerpts in order, with the Topic and title of its chat; none when the chat is no longer registered. */
export function sourceRows<R>(
  db: Db<R>,
  range: Range,
):
  | {
      readonly rows: readonly (ExcerptRow & { readonly text: string })[]
      readonly topic: number
      readonly topicName: string
      readonly title: string | null
    }
  | undefined {
  const [place] = Schema.decodeUnknownSync(Schema.Array(Place))(
    db.all(sql`
      SELECT t.id AS topic, t.name AS topicName, c.title AS title
      FROM app_conversations c JOIN app_topics t ON t.id = c.topic_id
      WHERE c.session_id = ${range.chat}`),
  )
  if (place === undefined) return undefined
  const rows = db.all(sql`
    SELECT entry_id AS entryId, role, author, text FROM app_transcript_excerpts
    WHERE chat_id = ${range.chat} AND entry_id BETWEEN ${range.start} AND ${range.end}
    ORDER BY entry_id`)
  return { ...place, rows: Schema.decodeUnknownSync(Rows)(rows) }
}

/** The Topic `name` names: its id as digits, or its name ignoring case (an active one before an archived one). */
export function topicByName<R>(db: Db<R>, name: string): number | undefined {
  const clean = name.replaceAll(/\s+/gu, ' ').trim().replace(/^#/u, '')
  const id = /^\d{1,12}$/u.test(clean) ? Number(clean) : -1
  const rows = db.all(sql`
    SELECT id FROM app_topics WHERE id = ${id} OR name = ${clean} COLLATE NOCASE
    ORDER BY (id = ${id}) DESC, (archived_at IS NULL) DESC, archived_at DESC LIMIT 1`)
  return Schema.decodeUnknownSync(Ids)(rows)[0]?.id
}

/**
 * The Pi sessions a catch-up visits: every registered chat but persona forks, except closed ones the index has read
 * since they closed (nothing new arrives there). Most recently checked last, so the stalest go first.
 */
export function chatsToIndex<R>(db: Db<R>): readonly string[] {
  const rows = db.all(sql`
    SELECT c.pi_session AS session FROM app_conversations c
    LEFT JOIN app_transcript_index i ON i.session_id = c.pi_session
    WHERE c.pi_session IS NOT NULL AND (c.role IS NULL OR c.role <> 'persona')
      AND NOT (c.closed_at IS NOT NULL AND i.checked_at IS NOT NULL AND i.checked_at >= c.closed_at)
    ORDER BY coalesce(i.checked_at, 0) ASC, c.created_at DESC`)
  return Schema.decodeUnknownSync(Sessions)(rows).map((row) => row.session)
}
