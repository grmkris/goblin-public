import { and, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appNotices, appNoticeWindows } from '../storage/notices.ts'

/** A notice as the store keeps it. */
export type NoticeRow = typeof appNotices.$inferSelect
/** A notice to claim: everything but the state the store keeps for it. */
export type NewNotice = Omit<
  NoticeRow,
  'readAt' | 'writtenAt' | 'telegramState' | 'telegramText' | 'telegramAttempts' | 'telegramNextAt' | 'telegramReceipt'
> & { readonly telegramText?: string }

/** How many notices a routine posts in an hour; the rest wait for one digest line (ADR 0041). */
export const NOTICE_CAP = 20
export const NOTICE_WINDOW = 3_600_000

/** A window that ended with notices past its cap: the digest it owes. */
export type DigestDue = { readonly routineId: string; readonly startedAt: number; readonly folded: number }

/** What a claim did: posted the notice, or folded it into the digest; and a digest the window that ended owes. */
export type Claim = { readonly posted: boolean; readonly digest?: DigestDue }

/**
 * Notices and the routines' hours of them (ADR 0041). Every method is synchronous and short, so a claim can run inside
 * an event's acknowledgement (`Events.ackWith`): the notice, its window and the acknowledgement commit together.
 */
export class NoticeStore {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  /**
   * Keeps `notice` once: a notice already claimed (a replayed delivery) is not kept or counted again. A `capped` one
   * (an event's) is counted into its routine's hour and kept only while the hour has room, else folded into the hour's
   * digest; a new hour reports the digest the last one owes. Reminders, answers and digests are not counted.
   */
  claim(notice: NewNotice, capped: boolean): Claim {
    return this.#db.transaction((tx) => {
      if (tx.select({ id: appNotices.id }).from(appNotices).where(eq(appNotices.id, notice.id)).get() !== undefined)
        return { posted: false }
      const keep = () =>
        tx
          .insert(appNotices)
          .values({ ...notice, telegramState: notice.telegramText === undefined ? 'none' : 'pending' })
          .run()
      if (!capped) {
        keep()
        return { posted: true }
      }
      const window = tx.select().from(appNoticeWindows).where(eq(appNoticeWindows.routineId, notice.routineId)).get()
      if (window === undefined || notice.at >= window.startedAt + NOTICE_WINDOW) {
        const next = { routineId: notice.routineId, startedAt: notice.at, sent: 1, folded: 0 }
        tx.insert(appNoticeWindows)
          .values(next)
          .onConflictDoUpdate({ target: appNoticeWindows.routineId, set: next })
          .run()
        keep()
        return window === undefined || window.folded === 0
          ? { posted: true }
          : {
              posted: true,
              digest: { routineId: window.routineId, startedAt: window.startedAt, folded: window.folded },
            }
      }
      const room = window.sent < NOTICE_CAP
      tx.update(appNoticeWindows)
        .set(room ? { sent: window.sent + 1 } : { folded: window.folded + 1 })
        .where(eq(appNoticeWindows.routineId, notice.routineId))
        .run()
      if (room) keep()
      return { posted: room }
    })
  }

  /** Windows that ended with notices folded, whose digest is owed now; each is cleared as it is taken. */
  digestsDue(now: number): readonly DigestDue[] {
    return this.#db.transaction((tx) => {
      const due = tx
        .select()
        .from(appNoticeWindows)
        .where(and(lte(appNoticeWindows.startedAt, now - NOTICE_WINDOW), gte(appNoticeWindows.folded, 1)))
        .all()
      for (const window of due)
        tx.update(appNoticeWindows).set({ folded: 0 }).where(eq(appNoticeWindows.routineId, window.routineId)).run()
      return due.map(({ routineId, startedAt, folded }) => ({ routineId, startedAt, folded }))
    })
  }

  /** Notices claimed whose entry is not written yet (a write the agent did not finish). */
  unwritten(): readonly NoticeRow[] {
    return this.#db.select().from(appNotices).where(isNull(appNotices.writtenAt)).limit(64).all()
  }

  written(id: string, at: number): void {
    this.#db.update(appNotices).set({ writtenAt: at }).where(eq(appNotices.id, id)).run()
  }

  get(id: string): NoticeRow | undefined {
    return this.#db.select().from(appNotices).where(eq(appNotices.id, id)).get()
  }

  /** The newest notices written since `since` (ms), at most `limit`. */
  recent(since: number, limit: number): readonly NoticeRow[] {
    return this.#db
      .select()
      .from(appNotices)
      .where(and(gte(appNotices.at, since), gte(appNotices.writtenAt, 0)))
      .orderBy(desc(appNotices.at))
      .limit(limit)
      .all()
  }

  /** The owner read these notices at `at`. */
  read(ids: readonly string[], at: number): void {
    if (ids.length === 0) return
    this.#db
      .update(appNotices)
      .set({ readAt: at })
      .where(and(inArray(appNotices.id, [...ids]), isNull(appNotices.readAt)))
      .run()
  }

  /** Forgets notices older than `before` (ms). */
  prune(before: number): void {
    this.#db.delete(appNotices).where(lte(appNotices.at, before)).run()
  }
}
