import {
  type ExecuteQuoteInput,
  type PaidFetchInput,
  type Quote,
  termsHash,
  type TransferInput,
} from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { failure } from '../errors.ts'
import { Ledger } from '../ledger.ts'
import { type FrozenQuote, Rails, type RailsPort } from '../rails.ts'
import { allowedServices } from './services-list.ts'
import { argsHashOf, type SpendPlan } from './spend.ts'

/** The wallet's own addresses: paying them never needs first-use approval. */
const ownAddresses = Effect.gen(function* () {
  const profile = yield* (yield* Ledger).use((api) => api.profile())
  return [profile.ownerAddress, profile.agentAddress].filter((address) => address !== undefined)
})

/** `paid_fetch`: an allowed service, quoted by the rail, paid once. */
export const paidFetchPlan = (input: PaidFetchInput, client: string) =>
  Effect.gen(function* () {
    const overrides = yield* (yield* Ledger).use((api) => api.serviceOverrides())
    const service = allowedServices(overrides).find((candidate) => candidate.id === input.service)
    if (service === undefined)
      return yield* failure(
        'unknown_service',
        `${input.service} is not on the owner's list of paid services.`,
        404,
        'Call services for the allowed ones, or request_policy_change to ask the owner to add it.',
      )
    if (input.rail !== undefined && !service.rails.includes(input.rail))
      return yield* failure('rail_not_offered', `${service.id} cannot be paid over ${input.rail}.`, 400)
    const plan: SpendPlan = {
      operationId: input.operation_id,
      argsHash: yield* Effect.promise(() => argsHashOf('paid_fetch', input)),
      maxUsd: input.max_usd,
      client,
      capUsd: service.maxPerCall,
      exempt: [],
      quote: (port) => port.quotePaidFetch(service, input.args, input.rail),
      pay: (port, operation) => port.payPaidFetch(operation, service, input.args),
    }
    return plan
  })

/** `transfer`: a token transfer from the wallet; a first payment to a new recipient asks the owner. */
export const transferPlan = (input: TransferInput, client: string) =>
  Effect.gen(function* () {
    const plan: SpendPlan = {
      operationId: input.operation_id,
      argsHash: yield* Effect.promise(() => argsHashOf('transfer', input)),
      maxUsd: input.max_usd,
      client,
      exempt: yield* ownAddresses,
      quote: (port) => port.quoteTransfer(input),
      pay: (port, operation) => port.transfer(operation),
    }
    return plan
  })

/**
 * `swap_execute` and `bridge_execute`: the frozen quote's terms, never re-derived from new arguments. A live quote is
 * required only to start a new operation: an operation the ledger already has is replayed (finished or in flight)
 * whatever has become of its quote, so a lost reply never turns into `quote_expired` and a second payment.
 */
export const executeQuotePlan = (kind: 'swap' | 'bridge', input: ExecuteQuoteInput, client: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger
    const argsHash = yield* Effect.promise(() => argsHashOf(`${kind}_execute`, input))
    const seen = yield* ledger.use((api) => api.lookup(input.operation_id, argsHash))
    const stored = yield* ledger.use((api) => api.getQuote(input.quote_id, true))
    const live = (yield* ledger.use((api) => api.getQuote(input.quote_id))) !== undefined
    if (stored === undefined || stored.kind !== kind || (seen.kind === 'none' && !live))
      return yield* failure(
        'quote_expired',
        `No live ${kind} quote ${input.quote_id}.`,
        404,
        `Ask for a new ${kind}_quote and execute that.`,
      )
    const plan: SpendPlan = {
      operationId: input.operation_id,
      argsHash,
      maxUsd: input.max_usd,
      client,
      exempt: yield* ownAddresses,
      boundTermsHash: yield* Effect.promise(() => termsHash(stored.terms)),
      quote: () => Promise.resolve(stored.terms),
      pay: (port, operation) =>
        kind === 'swap' ? port.swapExecute(operation, stored.payload) : port.bridgeExecute(operation, stored.payload),
    }
    return plan
  })

/** `swap_quote` and `bridge_quote`: ask the rail, freeze the answer in the ledger and hand back its id. */
export const freezeQuote = (kind: 'swap' | 'bridge', ask: (port: RailsPort) => Promise<FrozenQuote>) =>
  Effect.gen(function* () {
    const rails = yield* Rails
    const frozen = yield* rails.use(ask)
    yield* (yield* Ledger).use((api) =>
      api.putQuote({ kind, quote: frozen.quote, terms: frozen.terms, payload: frozen.payload }),
    )
    return frozen.quote satisfies Quote
  })
