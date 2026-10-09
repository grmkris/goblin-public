import type { OrganizeReceipt } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { NewReceipt, StoredReceipt } from './receipts.ts'

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
>()('goblin/organize/Receipts') {}
