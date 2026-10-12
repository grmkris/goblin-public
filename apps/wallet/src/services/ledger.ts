import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { LedgerApi } from '../ledger/durable.ts'
import { failure, type WalletFailure } from './errors.ts'

/** The owner's ledger Durable Object. `use` runs ledger calls; a Durable Object that cannot be reached is a 503. */
export class Ledger extends Context.Service<
  Ledger,
  { readonly use: <A>(call: (ledger: LedgerApi) => Promise<A>) => Effect.Effect<A, WalletFailure> }
>()('goblin/wallet/Ledger') {}

export const ledgerLayer = (ledger: LedgerApi): Layer.Layer<Ledger> =>
  Layer.succeed(Ledger, {
    use: (call) =>
      Effect.tryPromise({
        try: () => call(ledger),
        catch: () => failure('ledger_unavailable', 'The wallet ledger did not answer.', 503, 'Try again in a moment.'),
      }),
  })
