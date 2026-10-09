import type { PersonaInvocationView } from '@goblin/contracts'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { appPersonaInvocations } from '../storage/personas.ts'

type Row = typeof appPersonaInvocations.$inferSelect
type State = PersonaInvocationView['state']

const LIVE: readonly State[] = ['pending', 'running']

const view = (row: Row): PersonaInvocationView => ({
  operationId: row.operationId,
  persona: row.personaId,
  revision: row.revision,
  chat: row.chatId,
  order: row.ord,
  state: row.state,
  ...(row.answerEntry === null ? {} : { answerEntry: row.answerEntry }),
  createdAt: row.createdAt,
  ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
})

/** One tagged Persona on one owner message, as the registry of Persona turns keeps it. */
export type NewInvocation = {
  readonly operationId: string
  readonly persona: number
  readonly revision: number
  readonly chat: string
  readonly order: number
}

/**
 * Which Persona answers which owner message, and how far it got (ADR 0033). The row is the owner-visible state; the
 * `goblin.persona-turn` task in Pi does the work and reports into it. A settled row never moves again, so a replayed
 * step or a Stop after the answer changes nothing.
 */
export class PersonaInvocations<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  readonly #listeners = new Set<(invocations: readonly PersonaInvocationView[]) => void>()

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>) {
    this.#db = db
  }

  /** Calls `listener` with each invocation written; returns what unsubscribes it. */
  onChange(listener: (invocations: readonly PersonaInvocationView[]) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(rows: readonly Row[]): void {
    if (rows.length === 0) return
    const invocations = rows.map(view)
    for (const listener of this.#listeners) listener(invocations)
  }

  /** Records the tagged Personas of one send, once per operation and Persona. */
  insert(invocations: readonly NewInvocation[], now: number): readonly PersonaInvocationView[] {
    const rows = this.#db.transaction(() =>
      invocations.flatMap((each) =>
        this.#db
          .insert(appPersonaInvocations)
          .values({
            operationId: each.operationId,
            personaId: each.persona,
            revision: each.revision,
            chatId: each.chat,
            ord: each.order,
            state: 'pending',
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning()
          .all(),
      ),
    )
    this.#emit(rows)
    return rows.map(view)
  }

  get(operationId: string, persona: number): PersonaInvocationView | undefined {
    const row = this.#db
      .select()
      .from(appPersonaInvocations)
      .where(and(eq(appPersonaInvocations.operationId, operationId), eq(appPersonaInvocations.personaId, persona)))
      .get()
    return row === undefined ? undefined : view(row)
  }

  /** The invocations not settled yet, oldest first: what a reload still shows as answering. */
  live(): readonly PersonaInvocationView[] {
    return this.#db
      .select()
      .from(appPersonaInvocations)
      .where(inArray(appPersonaInvocations.state, [...LIVE]))
      .orderBy(asc(appPersonaInvocations.createdAt), asc(appPersonaInvocations.ord))
      .all()
      .map(view)
  }

  /** Every invocation of one send, in order. */
  of(operationId: string): readonly PersonaInvocationView[] {
    return this.#db
      .select()
      .from(appPersonaInvocations)
      .where(eq(appPersonaInvocations.operationId, operationId))
      .orderBy(asc(appPersonaInvocations.ord))
      .all()
      .map(view)
  }

  /** The Persona started working. Only a pending invocation moves. */
  running(operationId: string, persona: number): void {
    const rows = this.#db
      .update(appPersonaInvocations)
      .set({ state: 'running' })
      .where(
        and(
          eq(appPersonaInvocations.operationId, operationId),
          eq(appPersonaInvocations.personaId, persona),
          eq(appPersonaInvocations.state, 'pending'),
        ),
      )
      .returning()
      .all()
    this.#emit(rows)
  }

  /** Settles one invocation; a settled one stays as it is. Whether this call settled it. */
  settle(
    operationId: string,
    persona: number,
    state: 'answered' | 'failed' | 'stopped',
    now: number,
    answerEntry?: number,
  ): boolean {
    const rows = this.#db
      .update(appPersonaInvocations)
      .set({ state, settledAt: now, ...(answerEntry === undefined ? {} : { answerEntry }) })
      .where(
        and(
          eq(appPersonaInvocations.operationId, operationId),
          eq(appPersonaInvocations.personaId, persona),
          inArray(appPersonaInvocations.state, [...LIVE]),
        ),
      )
      .returning()
      .all()
    this.#emit(rows)
    return rows.length > 0
  }

  /** Stops every unsettled invocation in `chat`: the owner's Stop. */
  stopChat(chat: string, now: number): number {
    const rows = this.#db
      .update(appPersonaInvocations)
      .set({ state: 'stopped', settledAt: now })
      .where(and(eq(appPersonaInvocations.chatId, chat), inArray(appPersonaInvocations.state, [...LIVE])))
      .returning()
      .all()
    this.#emit(rows)
    return rows.length
  }
}
