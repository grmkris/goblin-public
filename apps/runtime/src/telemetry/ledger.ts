import { RunAttributes, RunEvent, RunEventKind, RunEventStatus } from '@goblin/contracts/telemetry'
import { and, asc, desc, eq, gte, inArray, lt, like, or } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Schema from 'effect/Schema'
import { appRunEvents } from '../storage/schema.ts'
import { boundAttributes, type RunSink } from './events.ts'
import { incompleteAnswer, needsAttention } from './attention.ts'
import { expectedFailure } from './safety.ts'

/** How long the ledger keeps an event (ADR 0024). */
export const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const decodeKind = Schema.decodeUnknownSync(RunEventKind)
const decodeStatus = Schema.decodeUnknownSync(RunEventStatus)
const decodeAttributes = Schema.decodeUnknownSync(Schema.fromJsonString(RunAttributes))

type Row = typeof appRunEvents.$inferSelect

const eventOf = (row: Row): RunEvent => ({
  id: row.id,
  kind: decodeKind(row.kind),
  status: decodeStatus(row.status),
  ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
  ...(row.operationId === null ? {} : { operationId: row.operationId }),
  ...(row.taskId === null ? {} : { taskId: row.taskId }),
  startedAt: row.startedAt,
  ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
  attributes: boundAttributes(decodeAttributes(row.attributes)),
})

const rowOf = (event: RunEvent): Row => ({
  id: event.id,
  kind: event.kind,
  status: event.status,
  conversationId: event.conversationId ?? null,
  operationId: event.operationId ?? null,
  taskId: event.taskId ?? null,
  startedAt: event.startedAt,
  endedAt: event.endedAt ?? null,
  attributes: JSON.stringify(event.attributes),
})

/** Leave room for fixed query parameters below Workers SQLite's 100-parameter limit. */
const PROBLEM_PAGE_SIZE = 64

/**
 * The agent's run ledger in its own SQLite (`app_run_events`). Writes are single statements, never held across an
 * await, so they are safe inside Pi's synchronous commit listener.
 */
export class RunLedger implements RunSink {
  readonly name = 'ledger'
  readonly #db: DrizzleSqliteDODatabase

  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  started(event: RunEvent): void {
    this.#write(event)
  }

  ended(event: RunEvent): void {
    this.#write(event)
  }

  /** The event `id`, in whatever state it was last written. */
  read(id: string): RunEvent | undefined {
    const row = this.#db.select().from(appRunEvents).where(eq(appRunEvents.id, id)).get()
    return row === undefined ? undefined : eventOf(row)
  }

  /** The newest event of `kind` for a Pi task: the model attempt a response answers, after a restart too. */
  latestForTask(kind: RunEventKind, taskId: string): RunEvent | undefined {
    const row = this.#db
      .select()
      .from(appRunEvents)
      .where(and(eq(appRunEvents.taskId, taskId), eq(appRunEvents.kind, kind)))
      .orderBy(desc(appRunEvents.startedAt))
      .limit(1)
      .get()
    return row === undefined ? undefined : eventOf(row)
  }

  /** Every event of one turn, in the order they started. */
  forOperation(operationId: string): readonly RunEvent[] {
    return this.#db
      .select()
      .from(appRunEvents)
      .where(eq(appRunEvents.operationId, operationId))
      .orderBy(asc(appRunEvents.startedAt), asc(appRunEvents.id))
      .all()
      .map(eventOf)
  }

  /** The events of several turns, for their summaries. */
  forOperations(operationIds: readonly string[]): readonly RunEvent[] {
    if (operationIds.length === 0) return []
    return this.#db
      .select()
      .from(appRunEvents)
      .where(inArray(appRunEvents.operationId, [...operationIds]))
      .all()
      .map(eventOf)
  }

  /** Turns that started since `since`, newest first, optionally in one conversation. */
  turns(since: number, limit: number, conversationId?: string): readonly RunEvent[] {
    const conversation = conversationId === undefined ? [] : [eq(appRunEvents.conversationId, conversationId)]
    return this.#db
      .select()
      .from(appRunEvents)
      .where(and(eq(appRunEvents.kind, 'turn.submitted'), gte(appRunEvents.startedAt, since), ...conversation))
      .orderBy(desc(appRunEvents.startedAt))
      .limit(limit)
      .all()
      .map(eventOf)
  }

  /** Events that failed, were blocked or were cut short since `since`, newest first. */
  problems(since: number, limit: number, all = false): readonly RunEvent[] {
    const problems: RunEvent[] = []
    let before: RunEvent | undefined
    while (problems.length < limit) {
      const page = this.#problemPage(since, before)
      const candidates = page.filter(
        (event) => (event.status !== 'ok' && event.status !== 'started') || incompleteAnswer(event),
      )
      const peers = all ? [] : this.#successfulAttempts(candidates)
      problems.push(
        ...candidates.filter((event) => all || needsAttention(event, peers)).slice(0, limit - problems.length),
      )
      if (page.length < PROBLEM_PAGE_SIZE) break
      before = page.at(-1)
    }
    return problems
  }

  #problemPage(since: number, before?: RunEvent): readonly RunEvent[] {
    const cursor =
      before === undefined
        ? undefined
        : or(
            lt(appRunEvents.startedAt, before.startedAt),
            and(eq(appRunEvents.startedAt, before.startedAt), lt(appRunEvents.id, before.id)),
          )
    return this.#db
      .select()
      .from(appRunEvents)
      .where(
        and(
          gte(appRunEvents.startedAt, since),
          cursor,
          or(
            inArray(appRunEvents.status, ['error', 'blocked', 'interrupted']),
            and(
              eq(appRunEvents.kind, 'model.attempt'),
              or(
                like(appRunEvents.attributes, '%"goblin.cutoff":true%'),
                like(appRunEvents.attributes, '%"goblin.empty_answer":true%'),
                like(appRunEvents.attributes, '%"gen_ai.response.finish_reasons"%"length"%'),
              ),
            ),
            like(appRunEvents.attributes, '%"goblin.coverage_gap":true%'),
          ),
        ),
      )
      .orderBy(desc(appRunEvents.startedAt), desc(appRunEvents.id))
      .limit(PROBLEM_PAGE_SIZE)
      .all()
      .map(eventOf)
  }

  #successfulAttempts(events: readonly RunEvent[]): readonly RunEvent[] {
    const taskIds = events.flatMap((event) =>
      event.kind === 'model.attempt' &&
      event.taskId !== undefined &&
      event.status !== 'ok' &&
      event.status !== 'started' &&
      !incompleteAnswer(event) &&
      !expectedFailure(event.attributes['error.type'])
        ? [event.taskId]
        : [],
    )
    if (taskIds.length === 0) return []
    return this.#db
      .select()
      .from(appRunEvents)
      .where(
        and(
          eq(appRunEvents.kind, 'model.attempt'),
          eq(appRunEvents.status, 'ok'),
          inArray(appRunEvents.taskId, taskIds),
        ),
      )
      .all()
      .map(eventOf)
  }

  /**
   * At start, before any new work: whatever was still `started` belonged to the previous run of this object and
   * stopped with it, so it is `interrupted`. Events past retention go. Returns how many were interrupted.
   */
  sweep(now: number): number {
    const interrupted = this.#db
      .update(appRunEvents)
      .set({ status: 'interrupted', endedAt: now })
      .where(eq(appRunEvents.status, 'started'))
      .returning({ id: appRunEvents.id })
      .all().length
    this.#db
      .delete(appRunEvents)
      .where(lt(appRunEvents.startedAt, now - LEDGER_RETENTION_MS))
      .run()
    return interrupted
  }

  #write(event: RunEvent): void {
    const row = rowOf(event)
    this.#db.insert(appRunEvents).values(row).onConflictDoUpdate({ target: appRunEvents.id, set: row }).run()
  }
}
