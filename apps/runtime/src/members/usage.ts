import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Schema } from 'effect'
import type { RuntimeEnv } from '../env.ts'
import { utcDay } from '../budget.ts'
import { databaseOperation } from '../workspaces/store.ts'

const daily = sqliteTable(
  'app_member_account_usage',
  {
    userId: text('user_id').notNull(),
    day: text('day').notNull(),
    tokens: integer('tokens').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
)
const counters = sqliteTable(
  'app_member_usage_counters',
  {
    userId: text('user_id').notNull(),
    source: text('source').notNull(),
    tokens: integer('tokens').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.source] })],
)
const Usage = Schema.Struct({
  models: Schema.Record(Schema.String, Schema.Struct({ totalTokens: Schema.Number })),
  tools: Schema.Record(Schema.String, Schema.Struct({ totalTokens: Schema.Number })),
})

/** Account-wide committed usage. Cumulative watermarks make retries and reconstruction idempotent. */
export class MemberUsage {
  readonly #db: ReturnType<typeof drizzle>
  readonly #owner: string
  readonly #weights: Readonly<Record<string, number>>
  constructor(env: RuntimeEnv, owner: string, weights: Readonly<Record<string, number>>) {
    this.#db = drizzle(env.AUTH_DB)
    this.#owner = owner
    this.#weights = weights
  }
  async project(userId: string, session: string, value: unknown, at: number): Promise<void> {
    const usage = Schema.decodeUnknownSync(Usage)(value)
    for (const [bucket, count] of Object.entries(usage.models))
      await this.#bucket(
        userId,
        `${this.#owner}:${session}:models:${bucket}`,
        count.totalTokens,
        this.#weights[bucket.slice(bucket.indexOf('/') + 1)] ?? 1,
        at,
      )
    for (const [bucket, count] of Object.entries(usage.tools))
      await this.#bucket(userId, `${this.#owner}:${session}:tools:${bucket}`, count.totalTokens, 1, at)
  }
  async #bucket(userId: string, source: string, raw: number, weight: number, at: number): Promise<void> {
    if (!Number.isFinite(raw) || raw < 0) return
    const tokens = Math.ceil(raw * weight)
    const day = utcDay(Math.floor(at / 1000)).day
    const previous = sql<number>`COALESCE((SELECT tokens FROM app_member_usage_counters WHERE user_id = ${userId} AND source = ${source}), 0)`
    await databaseOperation(() =>
      this.#db.batch([
        this.#db
          .insert(daily)
          .select(sql`SELECT ${userId}, ${day}, ${tokens} - ${previous} WHERE ${tokens} > ${previous}`)
          .onConflictDoUpdate({
            target: [daily.userId, daily.day],
            set: { tokens: sql`${daily.tokens} + excluded.tokens` },
          }),
        this.#db
          .insert(counters)
          .values({ userId, source, tokens })
          .onConflictDoUpdate({
            target: [counters.userId, counters.source],
            set: { tokens },
            where: sql`${counters.tokens} < ${tokens}`,
          }),
      ]),
    )
  }
  async tokens(userId: string, day: string): Promise<number> {
    return (
      (
        await databaseOperation(() =>
          this.#db
            .select()
            .from(daily)
            .where(and(eq(daily.userId, userId), eq(daily.day, day)))
            .get(),
        )
      )?.tokens ?? 0
    )
  }
}
