import type {
  ChainBalance,
  ExecuteQuoteInput,
  Operation,
  Payment,
  Quote,
  ServiceRule,
  SwapQuoteInput,
  BridgeQuoteInput,
  Terms,
  TransferInput,
  UpgradeRequest,
} from '@goblin/wallet/contract'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { failure, type WalletFailure } from './errors.ts'

/** The bounded response of a paid request. */
export interface PaidResponse {
  status: number
  contentType: string
  body: unknown
  truncated: boolean
}

/**
 * What a rail says happened. `failed` means no money moved (the reservation is released); `uncertain` means it may
 * have (the reservation stays and nothing retries). A rail that throws is treated as `uncertain`.
 */
export type PayOutcome =
  | { outcome: 'settled'; payment: Payment; delivery?: { status: string; detail?: string }; response?: PaidResponse }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'uncertain'; reason: string; payment?: Payment }

/** A swap or bridge quote the wallet froze: the owner-visible quote, the terms approval binds to, the rail's payload. */
export interface FrozenQuote {
  quote: Quote
  terms: Terms
  /** Opaque to the wallet; the rail gets it back at execute time. */
  payload: unknown
}

/**
 * The rails (lane D), as the spend program sees them. A rail quotes the exact terms a spend would have, then pays them;
 * it never decides limits. Every method may throw; the seam turns that into a typed failure.
 */
export interface RailsPort {
  quotePaidFetch(service: ServiceRule, args: Record<string, unknown>, rail?: 'x402' | 'mpp'): Promise<Terms>
  payPaidFetch(operation: Operation, service: ServiceRule, args: Record<string, unknown>): Promise<PayOutcome>
  quoteTransfer(input: TransferInput): Promise<Terms>
  transfer(operation: Operation): Promise<PayOutcome>
  swapQuote(input: SwapQuoteInput): Promise<FrozenQuote>
  swapExecute(operation: Operation, payload: unknown): Promise<PayOutcome>
  bridgeQuote(input: BridgeQuoteInput): Promise<FrozenQuote>
  bridgeExecute(operation: Operation, payload: unknown): Promise<PayOutcome>
  balances(): Promise<ChainBalance[]>
  /** Relays the owner's signed EIP-7702 authorization. */
  upgrade(request: UpgradeRequest): Promise<Operation>
}

export type { ExecuteQuoteInput }

export class Rails extends Context.Service<
  Rails,
  { readonly use: <A>(call: (rails: RailsPort) => Promise<A>) => Effect.Effect<A, WalletFailure> }
>()('goblin/wallet/Rails') {}

export const railsLayer = (rails: RailsPort): Layer.Layer<Rails> =>
  Layer.succeed(Rails, {
    use: (call) =>
      Effect.tryPromise({
        try: () => call(rails),
        catch: () => failure('rail_unavailable', 'The payment rail did not answer.', 502, 'Try again in a moment.'),
      }),
  })
