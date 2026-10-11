import type { NotificationView } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { Claim, DigestDue, NewNotice, NoticeRow, TelegramOutcome } from './store.ts'

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** Notifications written or read (ADR 0041), by id. */
    readonly 'notices.changed': { readonly ids: readonly string[] }
  }
}

/**
 * The routines' notices and notifications (ADR 0041) over the agent's SQLite (`NoticeStore`, wrapped once by the
 * routines' layer).
 */
export class Notices extends Context.Service<
  Notices,
  {
    /** Counts a notice into its routine's hour (when `capped`) and keeps it, or folds it into the hour's digest. */
    readonly claim: (notice: NewNotice, capped: boolean) => Effect.Effect<Claim, AppError>
    readonly get: (id: string) => Effect.Effect<NoticeRow | undefined>
    /** Its entry is in the chat now. */
    readonly written: (id: string, at: number) => Effect.Effect<void, AppError>
    /** The digests ended hours owe, each taken once. */
    readonly digestsDue: (now: number) => Effect.Effect<readonly DigestDue[], AppError>
    /** Notices claimed whose entry was not written (a write cut short). */
    readonly unwritten: () => Effect.Effect<readonly NoticeRow[]>
    /** Forgets notices older than `before` (ms). */
    readonly prune: (before: number) => Effect.Effect<void, AppError>
    /** Written notices whose Telegram copy is due. */
    readonly telegramDue: (at: number) => Effect.Effect<readonly NoticeRow[]>
    /** Claims one attempt of a Telegram copy; false when another attempt holds it. */
    readonly claimTelegram: (
      id: string,
      attempts: number,
      connectionId: string | null,
      at: number,
    ) => Effect.Effect<boolean>
    readonly telegramDone: (id: string, outcome: TelegramOutcome) => Effect.Effect<void>
    /** The newest written notifications of the last thirty days, for Activity. */
    readonly views: Effect.Effect<readonly NotificationView[]>
    readonly view: (id: string) => Effect.Effect<NotificationView | undefined>
    /** The owner read these at `at` (ms). */
    readonly read: (ids: readonly string[], at: number) => Effect.Effect<void, AppError>
  }
>()('goblin/notices/Notices') {}
