import type { OperationCheck } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { Ledger } from '../ledger.ts'
import { Rails } from '../rails.ts'
import { readOperation } from './operation.ts'

const chainName = (chain: string): string => `${chain.charAt(0).toUpperCase()}${chain.slice(1)}`

/**
 * Checks an operation whose outcome is unknown against the chain and records what it found: paid settles it, not paid
 * fails it and releases its hold, and anything less leaves it as it was. An operation already settled is not read.
 * It never pays: the evidence was recorded when the payment went out.
 */
export const checkOperation = (operationId: string) =>
  Effect.gen(function* () {
    const before = yield* readOperation(operationId)
    if (before.status !== 'uncertain')
      return { operation: before, found: 'known', note: `Its outcome is already known (${before.status}).` }
    const finding = yield* (yield* Rails).use((port) => port.check(before))
    const ledger = yield* Ledger
    if (finding.found === 'paid')
      yield* ledger.use((api) => api.settle(operationId, { payment: finding.payment, delivered: finding.delivered }))
    if (finding.found === 'not_paid') yield* ledger.use((api) => api.fail(operationId, finding.reason))
    const operation = yield* readOperation(operationId)
    const note =
      finding.found === 'paid'
        ? `Paid on ${chainName(before.terms.chain)}.`
        : finding.found === 'not_paid'
          ? `${finding.reason} The held amount is released.`
          : finding.reason
    return { operation, found: finding.found, note: note.slice(0, 240) } satisfies OperationCheck
  })
