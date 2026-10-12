import { usdToMicros } from '@goblin/wallet/amounts'
import { type ApprovalView, canonicalJson, type Operation, type Terms, termsHash } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { Approvals } from '../approvals.ts'
import { failure, type WalletFailure } from '../errors.ts'
import { Ledger } from '../ledger.ts'
import type { PaidResponse, PayOutcome } from '../rails.ts'
import { Rails, type RailsPort } from '../rails.ts'
import type { LedgerApi } from '../../ledger/durable.ts'

/** One spend, in the shape every paid tool shares: what it asks for, how to quote it and how to pay it. */
export interface SpendPlan {
  readonly operationId: string
  /** sha-256 of the canonical JSON of the tool and its arguments (without `operation_id`): the replay key. */
  readonly argsHash: string
  /** The most the caller agreed to pay, in USD. */
  readonly maxUsd: string
  readonly client: string
  /** Quotes the exact terms; runs only for an operation the ledger has not seen. */
  readonly quote: (port: RailsPort) => Promise<Terms>
  /** Pays a reserved operation. Runs at most once per operation. */
  readonly pay: (port: RailsPort, operation: Operation) => Promise<PayOutcome>
  /** Addresses that never need first-use approval (the owner's and the agent's own). */
  readonly exempt: readonly string[]
  /** The most one call to this service may cost (the service rule's cap), in USD. */
  readonly capUsd?: string
  /** The spend goes to a service the owner has not allowed yet. */
  readonly newService?: boolean
  /**
   * The terms hash this plan was built for (a frozen swap or bridge quote). The stored operation must carry the same
   * hash before anything is signed, so a payload is never paid under another operation's terms.
   */
  readonly boundTermsHash?: string
}

export type SpendOutcome =
  | { readonly kind: 'done'; readonly operation: Operation; readonly response?: PaidResponse; readonly replay: boolean }
  | {
      readonly kind: 'awaiting_approval'
      readonly operation: Operation
      readonly approval: ApprovalView
      readonly url: string
    }

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The replay key of a tool call: same tool and arguments (minus the operation id) hash the same. */
export const argsHashOf = (tool: string, input: Record<string, unknown>): Promise<string> => {
  const { operation_id: _operationId, ...rest } = input
  return sha256Hex(canonicalJson({ tool, input: rest }))
}

const ledgerCall = <A>(call: (api: LedgerApi) => Promise<A>) =>
  Effect.gen(function* () {
    return yield* (yield* Ledger).use(call)
  })

const FINISHED = new Set(['delivered', 'confirmed', 'failed', 'declined', 'expired', 'cancelled'])
const IN_FLIGHT = new Set(['signing', 'submitted', 'uncertain'])

const reused = failure(
  'operation_id_reused',
  'This operation_id was already used with different arguments.',
  409,
  'Use a new operation_id for a different request.',
)

/** Quote, freeze, check the cap and open the operation. */
const open = (plan: SpendPlan) =>
  Effect.gen(function* () {
    const rails = yield* Rails
    const terms = yield* rails.use((port) => plan.quote(port))
    if (usdToMicros(plan.maxUsd) < usdToMicros(terms.amountUsd))
      return yield* failure(
        'above_max_usd',
        `This costs $${terms.amountUsd}, above your max_usd of $${plan.maxUsd}. Nothing was spent.`,
        400,
        'Raise max_usd if you accept the price, or pick a cheaper option.',
      )
    if (plan.capUsd !== undefined && usdToMicros(terms.amountUsd) > usdToMicros(plan.capUsd))
      return yield* failure(
        'above_service_cap',
        `This costs $${terms.amountUsd}, above the $${plan.capUsd} cap on this service. Nothing was spent.`,
        400,
      )
    const hash = yield* Effect.promise(() => termsHash(terms))
    const begun = yield* ledgerCall((api) =>
      api.begin({ id: plan.operationId, argsHash: plan.argsHash, terms, termsHash: hash, client: plan.client }),
    )
    if (begun.kind === 'refused') return yield* failure(begun.code, begun.reason, 403)
    // A racing call with other arguments won the id between the lookup and the begin: this one must not run.
    if (begun.kind === 'conflict') return yield* reused
    return begun.operation
  })

const refuse = (code: string, reason: string): WalletFailure =>
  failure(code, reason, code === 'declined' || code === 'revoked' ? 403 : 409)

/** Reserves under every limit; returns the reserved operation or the approval the owner must give. */
const reserve = (plan: SpendPlan) =>
  Effect.gen(function* () {
    const reserved = yield* ledgerCall((api) =>
      api.reserve(plan.operationId, {
        exempt: plan.exempt.map((a) => a.toLowerCase()),
        newService: plan.newService === true,
      }),
    )
    if (reserved.kind === 'refused') return yield* refuse(reserved.code, reserved.reason)
    return reserved
  })

/** A rail that threw may have moved money, so the outcome is `uncertain` and the reservation stays. */
const payOnce = (plan: SpendPlan, operation: Operation) =>
  Effect.gen(function* () {
    const rails = yield* Rails
    return yield* rails
      .use((port) => plan.pay(port, operation))
      .pipe(
        // expected: a rail that threw may have moved money; the outcome is recorded as uncertain, not lost.
        Effect.catch((): Effect.Effect<PayOutcome> =>
          Effect.succeed({
            outcome: 'uncertain',
            reason: 'The payment rail did not answer, so the outcome is unknown.',
          }),
        ),
      )
  })

const record = (id: string, outcome: PayOutcome) => {
  if (outcome.outcome === 'settled')
    return ledgerCall((api) =>
      api.settle(id, {
        payment: outcome.payment,
        ...(outcome.delivery === undefined ? {} : { delivery: outcome.delivery }),
        delivered: outcome.delivery?.status !== 'failed',
      }),
    )
  if (outcome.outcome === 'failed') return ledgerCall((api) => api.fail(id, outcome.reason))
  const { payment, credential } = outcome
  // A credential handed to the caller is kept with the operation in the same move, so a retry returns it.
  if (credential !== undefined) return ledgerCall((api) => api.handOver(id, outcome.reason, credential))
  return ledgerCall((api) =>
    payment === undefined ? api.uncertain(id, outcome.reason) : api.uncertain(id, outcome.reason, payment),
  )
}

/** Signs and pays a reserved operation, then records what happened. */
const execute = (plan: SpendPlan, reserved: Operation) =>
  Effect.gen(function* () {
    if (plan.boundTermsHash !== undefined && plan.boundTermsHash !== reserved.termsHash)
      return yield* failure(
        'operation_id_reused',
        'This operation_id belongs to other terms than the quote being executed. Nothing was spent.',
        409,
      )
    const moved = yield* ledgerCall((api) => api.signing(plan.operationId))
    if (!moved.ok && 'reason' in moved) return yield* refuse(moved.code, moved.reason)
    if (!moved.ok) return { kind: 'done', operation: moved.operation ?? reserved, replay: true } satisfies SpendOutcome
    const outcome = yield* payOnce(plan, moved.operation)
    const recorded = yield* record(plan.operationId, outcome)
    const operation = recorded.ok ? recorded.operation : moved.operation
    const response = outcome.outcome === 'settled' ? outcome.response : undefined
    return {
      kind: 'done',
      operation,
      replay: false,
      ...(response === undefined ? {} : { response }),
    } satisfies SpendOutcome
  })

/**
 * The spend program every paid tool shares: replay or open the operation (frozen terms, `max_usd` honoured), reserve
 * under every ledger limit, wait for the owner when a limit or a first use asks for it, pay once through the rail and
 * record the outcome. A replay of a finished or in-flight operation returns it and never pays again.
 */
export const runSpend = (plan: SpendPlan) =>
  Effect.gen(function* () {
    const seen = yield* ledgerCall((api) => api.lookup(plan.operationId, plan.argsHash))
    if (seen.kind === 'conflict') return yield* reused
    const operation = seen.kind === 'replay' ? seen.operation : yield* open(plan)
    if (FINISHED.has(operation.status) || IN_FLIGHT.has(operation.status))
      return { kind: 'done', operation, replay: true } satisfies SpendOutcome
    const reserved = yield* reserve(plan)
    if (reserved.kind === 'awaiting_approval') {
      const url = (yield* Approvals).urlFor(plan.operationId)
      return {
        kind: 'awaiting_approval',
        operation: reserved.operation,
        approval: reserved.approval,
        url,
      } satisfies SpendOutcome
    }
    return yield* execute(plan, reserved.operation)
  })
