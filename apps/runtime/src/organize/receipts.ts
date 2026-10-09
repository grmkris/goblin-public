import type { OrganizeReceipt } from '@goblin/contracts'
import { desc, eq, sql } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import { NotFound } from '../http/errors.ts'
import { appOrganizeReceipts } from '../storage/personas.ts'

type Row = typeof appOrganizeReceipts.$inferSelect

export type ReceiptKind = OrganizeReceipt['kind']

/** What a receipt records: the target before and after the change (JSON-safe), and who and where it came from. */
export type NewReceipt = {
  readonly kind: ReceiptKind
  /** The Topic or Persona id, as text. */
  readonly target: string
  readonly summary: string
  readonly actor: 'owner' | 'agent'
  readonly chat?: string
  readonly before: unknown
  readonly after: unknown
  /** The target's revision right after the change: Undo applies only while it still is. */
  readonly afterRevision: number
  /** Makes a recorded change idempotent: the same key finds the same receipt. */
  readonly operationId?: string
}

type StoredBase = Omit<OrganizeReceipt, 'undoable'>

/** A stored receipt with its snapshots decoded. */
export type StoredReceipt = StoredBase & {
  readonly before: unknown
  readonly after: unknown
  readonly afterRevision: number
}

/** The revision the target of a receipt is at now; `undefined` when it no longer exists. */
export type RevisionOf = (kind: ReceiptKind, target: string) => number | undefined

const RECENT = 50

/**
 * Organizing receipts (ADR 0033): one row per change the owner or the agent made to Topics and Personas, with the
 * target before and after. Undo is offered while the target's revision is still the one the change left
 * (`undoable`); a later edit by anyone touches it, and then Undo is refused. The registry of the target is the
 * authority on its revision; this store only compares.
 */
export class OrganizeReceipts<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  readonly #revisionOf: RevisionOf
  readonly #listeners = new Set<(receipts: readonly OrganizeReceipt[]) => void>()

  constructor(db: SQLiteAsyncDatabase<'sync', RunResult>, revisionOf: RevisionOf) {
    this.#db = db
    this.#revisionOf = revisionOf
  }

  /** Calls `listener` with each receipt written or undone; returns what unsubscribes it. */
  onChange(listener: (receipts: readonly OrganizeReceipt[]) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #base(row: Row): StoredBase {
    return {
      id: row.id,
      kind: row.kind,
      target: row.target,
      summary: row.summary,
      actor: row.actor,
      ...(row.chatId === null ? {} : { chat: row.chatId }),
      at: row.createdAt,
      ...(row.undoneAt === null ? {} : { undoneAt: row.undoneAt }),
    }
  }

  #view(row: Row): OrganizeReceipt {
    const undoable = row.undoneAt === null && this.#revisionOf(row.kind, row.target) === row.afterRevision
    return { ...this.#base(row), undoable }
  }

  #emit(...rows: Row[]): void {
    const receipts = rows.map((row) => this.#view(row))
    for (const listener of this.#listeners) listener(receipts)
  }

  /** Records a change; the same `operationId` finds the receipt it already made. */
  record(input: NewReceipt, now: number): OrganizeReceipt {
    if (input.operationId !== undefined) {
      const existing = this.#db
        .select()
        .from(appOrganizeReceipts)
        .where(eq(appOrganizeReceipts.operationId, input.operationId))
        .get()
      if (existing !== undefined) return this.#view(existing)
    }
    const [row] = this.#db
      .insert(appOrganizeReceipts)
      .values({
        id: `org_${crypto.randomUUID().replaceAll('-', '')}`,
        operationId: input.operationId ?? null,
        kind: input.kind,
        target: input.target,
        summary: input.summary.slice(0, 300),
        actor: input.actor,
        chatId: input.chat ?? null,
        before: JSON.stringify(input.before),
        after: JSON.stringify(input.after),
        afterRevision: input.afterRevision,
        createdAt: now,
      })
      .returning()
      .all()
    if (row === undefined) throw new NotFound({ what: 'receipt' })
    this.#emit(row)
    return this.#view(row)
  }

  /** The newest receipts first, in the order they were written (several can share a second). */
  list(limit = RECENT): readonly OrganizeReceipt[] {
    return this.#db
      .select()
      .from(appOrganizeReceipts)
      .orderBy(desc(sql`rowid`))
      .limit(limit)
      .all()
      .map((row) => this.#view(row))
  }

  /** A receipt with its snapshots, for Undo. */
  get(id: string): StoredReceipt {
    const row = this.#db.select().from(appOrganizeReceipts).where(eq(appOrganizeReceipts.id, id)).get()
    if (row === undefined) throw new NotFound({ what: 'receipt' })
    return {
      ...this.#base(row),
      before: JSON.parse(row.before),
      after: JSON.parse(row.after),
      afterRevision: row.afterRevision,
    }
  }

  /** Marks a receipt undone. */
  markUndone(id: string, now: number): OrganizeReceipt {
    const [row] = this.#db
      .update(appOrganizeReceipts)
      .set({ undoneAt: now })
      .where(eq(appOrganizeReceipts.id, id))
      .returning()
      .all()
    if (row === undefined) throw new NotFound({ what: 'receipt' })
    this.#emit(row)
    return this.#view(row)
  }
}
