import { and, asc, eq, lt, ne } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Schema from 'effect/Schema'
import { appChatOperations } from '../storage/chat-operations.ts'

type Database<RunResult> = SQLiteAsyncDatabase<'sync', RunResult>
type Row = typeof appChatOperations.$inferSelect

/** How long a receipt is kept, in seconds: an operation replayed later than this is a new one. */
export const RECEIPT_RETENTION = 30 * 24 * 60 * 60

/** The operations a chat records (plan §3), besides passive writes. */
export const OPERATION_KINDS = [
  'send',
  'ask_client',
  'telegram',
  'persona_ask',
  'start',
  'reply',
  'empty',
  'move',
  'share',
  'close',
  'stop',
  'routine_input',
  'subagent_report',
] as const

/** What an operation in a chat is: one of `OPERATION_KINDS`, or `write:<entry kind>` for a passive write. */
export type OperationKind = (typeof OPERATION_KINDS)[number] | `write:${string}`
/** A receipt's kind: its operation's, or `legacy` for one admitted before receipts had kinds. */
export type ReceiptKind = OperationKind | 'legacy'

/** Who started an operation. */
export const ReceiptOrigin = Schema.Literals(['owner', 'client', 'telegram', 'agent', 'routine', 'system'])
export type ReceiptOrigin = typeof ReceiptOrigin.Type

/**
 * How far an operation got: `admitted` before Pi saw it, then `submitted` (an input Pi took), `written` (a passive
 * write Pi took), `refused` (turned away, with a reason) or `settled` (done, with nothing more to follow).
 */
export const ReceiptState = Schema.Literals(['admitted', 'submitted', 'written', 'refused', 'settled'])
export type ReceiptState = typeof ReceiptState.Type

/** What an admission says about its operation: its kind, who started it, and what it came from or led to. */
export type ReceiptInput = {
  readonly kind: OperationKind
  readonly origin: ReceiptOrigin
  /** The operation this one was made by (a thread's first message by its start, a write by its turn). */
  readonly parentOp?: string
  /** The chat the operation made or reached, when that is another one (a started thread, a move's Thread). */
  readonly targetChat?: string
}

/** An operation's receipt in one chat, as the runtime reads it. It carries ids and codes, never content. */
export type Receipt = {
  readonly chat: string
  readonly operationId: string
  readonly session: string
  readonly admittedAt: number
  readonly kind: ReceiptKind
  readonly origin?: ReceiptOrigin
  readonly targetChat?: string
  readonly parentOp?: string
  readonly state: ReceiptState
  /** Why it was refused: an error tag or a refusal code, never error text. */
  readonly reason?: string
  readonly settledAt?: number
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(OPERATION_KINDS)
const isOperationKind = (value: string): value is OperationKind => value.startsWith('write:') || KNOWN_KINDS.has(value)
const isOrigin = Schema.is(ReceiptOrigin)
const isState = Schema.is(ReceiptState)

/** A stored receipt. A row admitted before receipts had kinds reads as a `legacy` one, `admitted` and nothing more. */
export const decodeReceipt = (row: Row): Receipt => ({
  chat: row.chatId,
  operationId: row.operationId,
  session: row.sessionId,
  admittedAt: row.admittedAt,
  kind: row.kind !== null && isOperationKind(row.kind) ? row.kind : 'legacy',
  ...(row.origin !== null && isOrigin(row.origin) ? { origin: row.origin } : {}),
  ...(row.targetChat === null ? {} : { targetChat: row.targetChat }),
  ...(row.parentOp === null ? {} : { parentOp: row.parentOp }),
  state: row.state !== null && isState(row.state) ? row.state : 'admitted',
  ...(row.reason === null ? {} : { reason: row.reason }),
  ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
})

/** The receipt `operationId` has in `chat`, if it was admitted there. */
export function receiptIn<RunResult>(db: Database<RunResult>, chat: string, operationId: string): Receipt | undefined {
  const row = db
    .select()
    .from(appChatOperations)
    .where(and(eq(appChatOperations.chatId, chat), eq(appChatOperations.operationId, operationId)))
    .get()
  return row === undefined ? undefined : decodeReceipt(row)
}

/**
 * The first receipt of `operationId` in any chat, synchronously: what Pi's commit listener reads to tell where a
 * submission came from (its request id is the operation id).
 */
export function receiptOf<RunResult>(db: Database<RunResult>, operationId: string): Receipt | undefined {
  const row = db
    .select()
    .from(appChatOperations)
    .where(eq(appChatOperations.operationId, operationId))
    .orderBy(asc(appChatOperations.admittedAt))
    .limit(1)
    .get()
  return row === undefined ? undefined : decodeReceipt(row)
}

/** Every receipt `parentOp` led to, oldest first. */
export function relatedReceipts<RunResult>(db: Database<RunResult>, parentOp: string): readonly Receipt[] {
  return db
    .select()
    .from(appChatOperations)
    .where(eq(appChatOperations.parentOp, parentOp))
    .orderBy(asc(appChatOperations.admittedAt))
    .all()
    .map(decodeReceipt)
}

/** One admission: the chat, the operation, what it is, and the session it goes to when it is new. */
export type Admission = {
  readonly chat: string
  readonly operationId: string
  readonly receipt: ReceiptInput
  readonly session: () => string
  readonly now: number
}

/**
 * Records an operation's intent in its chat before Pi sees it, in one transaction, dropping every receipt past the
 * retention but this one. A replay finds its first receipt, so it keeps its first session, even after a rebind.
 */
export function admitReceipt<RunResult>(
  db: Database<RunResult>,
  admission: Admission,
): { readonly session: string; readonly existing: boolean } {
  const { chat, operationId, receipt, now } = admission
  return db.transaction(() => {
    db.delete(appChatOperations)
      .where(
        and(lt(appChatOperations.admittedAt, now - RECEIPT_RETENTION), ne(appChatOperations.operationId, operationId)),
      )
      .run()
    const previous = receiptIn(db, chat, operationId)
    if (previous !== undefined) return { session: previous.session, existing: true }
    const session = admission.session()
    db.insert(appChatOperations)
      .values({
        chatId: chat,
        operationId,
        sessionId: session,
        admittedAt: now,
        kind: receipt.kind,
        origin: receipt.origin,
        targetChat: receipt.targetChat ?? null,
        parentOp: receipt.parentOp ?? null,
        state: 'admitted',
      })
      .run()
    return { session, existing: false }
  })
}

/** How an operation went on: its new state, with a reason when refused; refused and settled stamp when. */
export type ReceiptChange = {
  readonly state: Exclude<ReceiptState, 'admitted'>
  readonly reason?: string
  readonly targetChat?: string
  readonly now: number
}

/** Moves `operationId`'s receipt in `chat` on to `change.state`; a receipt that is gone stays gone. */
export function advanceReceipt<RunResult>(
  db: Database<RunResult>,
  chat: string,
  operationId: string,
  change: ReceiptChange,
): void {
  const ends = change.state === 'refused' || change.state === 'settled'
  db.update(appChatOperations)
    .set({
      state: change.state,
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(change.targetChat === undefined ? {} : { targetChat: change.targetChat }),
      ...(ends ? { settledAt: change.now } : {}),
    })
    .where(and(eq(appChatOperations.chatId, chat), eq(appChatOperations.operationId, operationId)))
    .run()
}
