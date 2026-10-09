import type { OrganizeReceipt } from '@goblin/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import { Changes } from '../runtime/changes.ts'
import { fromStore, nowSeconds } from './effects.ts'
import type { NewReceipt, OrganizeReceipts, StoredReceipt } from './receipts.ts'

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** Receipts written or undone, by id (ADR 0033). */
    'receipts.changed': { readonly ids: readonly string[] }
  }
}

/**
 * What organizing changed (ADR 0033): one receipt per change the owner or the agent made to a Topic or Persona, with
 * the target before and after. Undo is offered while the target's revision is still the one the change left. Times
 * are read inside, in epoch seconds.
 */
export class Receipts extends Context.Service<
  Receipts,
  {
    /** Records a change; the same `operationId` finds the receipt it already made. */
    readonly record: (input: NewReceipt) => Effect.Effect<OrganizeReceipt, AppError>
    /** The newest receipts first. */
    readonly list: (limit?: number) => Effect.Effect<readonly OrganizeReceipt[]>
    /** A receipt with its snapshots, for Undo; `NotFound` when there is none with `id`. */
    readonly get: (id: string) => Effect.Effect<StoredReceipt, AppError>
    readonly markUndone: (id: string) => Effect.Effect<OrganizeReceipt, AppError>
  }
>()('goblin/organize/Receipts') {
  /**
   * The receipts over `store`, the one per agent: each record and Undo tells `receipts.changed`. A record found by its
   * operation id tells it again, which changes nothing a reader sees.
   */
  static readonly make = (store: OrganizeReceipts) =>
    Effect.gen(function* () {
      const changes = yield* Changes
      const changed = (id: string) => changes.publish('receipts.changed', { ids: [id] })
      return Receipts.of({
        record: Effect.fn('Receipts.record')(function* (input: NewReceipt) {
          const now = yield* nowSeconds
          const receipt = yield* fromStore(() => store.record(input, now))
          yield* changed(receipt.id)
          return receipt
        }),
        list: Effect.fn('Receipts.list')(function* (limit?: number) {
          return yield* Effect.sync(() => store.list(limit))
        }),
        get: Effect.fn('Receipts.get')(function* (id: string) {
          return yield* fromStore(() => store.get(id))
        }),
        markUndone: Effect.fn('Receipts.markUndone')(function* (id: string) {
          const now = yield* nowSeconds
          const receipt = yield* fromStore(() => store.markUndone(id, now))
          yield* changed(receipt.id)
          return receipt
        }),
      })
    })
}
