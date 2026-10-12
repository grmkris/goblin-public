import type { Operation } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { failure } from '../errors.ts'
import { Ledger } from '../ledger.ts'

/** One operation by its caller-chosen id. */
export const readOperation = (operationId: string) =>
  Effect.gen(function* () {
    const found = yield* (yield* Ledger).use((api) => api.operation(operationId))
    if (found === undefined)
      return yield* failure(
        'unknown_operation',
        `No operation ${operationId}.`,
        404,
        'Check the operation_id you used.',
      )
    return found satisfies Operation
  })
