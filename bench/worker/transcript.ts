import { DurableObject } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { migrate } from 'drizzle-orm/durable-sqlite/migrator'
import { Schema } from 'effect'
import { TranscriptMessage } from '../src/retrieval-corpus.ts'
import { ftsQuery } from '../src/retrieval-metrics.ts'
import { redactedExcerpt } from '../src/retrieval-excerpt.ts'
import { transcriptDDL } from './transcript-sql.ts'

/** Scratch actor only: no Pi, Agents, production schema or deployed data is written. */
interface Env {
  readonly TRANSCRIPTS: DurableObjectNamespace<TranscriptIndex>
}

export class TranscriptIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    if (
      ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='app_transcript_excerpts'").toArray().length === 0
    )
      ctx.storage.transactionSync(() => {
        for (const sql of transcriptDDL) ctx.storage.sql.exec(sql).toArray()
      })
  }
  probe() {
    const sql = this.ctx.storage.sql
    sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS app_trigram_probe USING fts5(text, tokenize='trigram')").toArray()
    sql.exec('INSERT INTO app_trigram_probe(text) VALUES (?)', 'Shinjuku').toArray()
    const trigram = sql.exec("SELECT text FROM app_trigram_probe WHERE app_trigram_probe MATCH 'inj'").toArray()
    sql.exec('DROP TABLE app_trigram_probe').toArray()
    return {
      fts5: true,
      trigram: trigram.length > 0,
      shadowTables: sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name GLOB 'app_transcript_fts_*' ORDER BY name")
        .toArray(),
      databaseBytes: sql.databaseSize,
    }
  }
  index(input: readonly TranscriptMessage[]) {
    const messages = Schema.decodeUnknownSync(Schema.Array(TranscriptMessage))(input)
    const sql = this.ctx.storage.sql
    const before = sql.databaseSize
    const writes: number[] = []
    this.ctx.storage.transactionSync(() => {
      for (const message of messages) {
        const cursor = sql.exec(
          'INSERT INTO app_transcript_excerpts(entry_id,session_id,chat_id,role,author,at,text) VALUES(?,?,?,?,?,?,?)',
          message.entryId,
          message.sessionId,
          message.chatId,
          message.role,
          message.author,
          message.at,
          redactedExcerpt(message.text),
        )
        cursor.toArray()
        writes.push(cursor.rowsWritten)
      }
      for (const sessionId of new Set(messages.map((message) => message.sessionId))) {
        const through = Math.max(
          ...messages.filter((message) => message.sessionId === sessionId).map((message) => message.entryId),
        )
        const cursor = sql.exec(
          'INSERT INTO app_transcript_index VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET through_entry=MAX(through_entry,excluded.through_entry)',
          sessionId,
          through,
        )
        cursor.toArray()
        writes.push(cursor.rowsWritten)
      }
    })
    return {
      beforeBytes: before,
      afterBytes: sql.databaseSize,
      rowsWritten: writes.reduce((a, b) => a + b, 0),
      perMessage: writes.slice(0, messages.length),
      checkpointRowsWritten: writes.slice(messages.length).reduce((a, b) => a + b, 0),
      shadowRows: this.shadowRows(),
    }
  }
  shadowRows() {
    const sql = this.ctx.storage.sql
    return Object.fromEntries(
      ['data', 'idx', 'docsize', 'config'].map((suffix) => [
        suffix,
        sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM app_transcript_fts_${suffix}`).one().n,
      ]),
    )
  }
  query(query: string) {
    const match = ftsQuery(query)
    if (match === '') return { rows: [], ms: 0, rowsRead: 0 }
    const start = performance.now()
    const cursor = this.ctx.storage.sql.exec<{ entryId: number; score: number; at: number }>(
      'SELECT e.entry_id AS entryId, bm25(app_transcript_fts) AS score, e.at FROM app_transcript_fts JOIN app_transcript_excerpts e ON e.entry_id=app_transcript_fts.rowid WHERE app_transcript_fts MATCH ? ORDER BY score ASC, e.at DESC, e.entry_id DESC LIMIT 20',
      match,
    )
    const rows = cursor.toArray()
    return { rows, ms: performance.now() - start, rowsRead: cursor.rowsRead }
  }
  mutate(entryId: number, text: string | null) {
    if (text === null)
      this.ctx.storage.sql.exec('DELETE FROM app_transcript_excerpts WHERE entry_id=?', entryId).toArray()
    else
      this.ctx.storage.sql
        .exec('UPDATE app_transcript_excerpts SET text=? WHERE entry_id=?', redactedExcerpt(text), entryId)
        .toArray()
  }
  scratchMigration() {
    // Same pinned drizzle(storage)+migrate raw-SQL path as storage/migrations.ts, without altering its migration list.
    const config = { migrations: { '20261008000000_fts_scratch': transcriptDDL.join('\n--> statement-breakpoint\n') } }
    this.ctx.storage.transactionSync(() => {
      for (const sql of [
        'DROP TRIGGER app_transcript_ai',
        'DROP TRIGGER app_transcript_ad',
        'DROP TRIGGER app_transcript_au',
        'DROP TABLE app_transcript_fts',
        'DROP TABLE app_transcript_excerpts',
        'DROP TABLE app_transcript_index',
      ])
        this.ctx.storage.sql.exec(sql).toArray()
    })
    migrate(drizzle(this.ctx.storage), config)
    migrate(drizzle(this.ctx.storage), config)
    return { appliedTwice: true, ...this.probe() }
  }
}
