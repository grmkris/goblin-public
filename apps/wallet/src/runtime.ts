import * as Effect from 'effect/Effect'
import type * as Layer from 'effect/Layer'
import type { WalletFailure } from './services/errors.ts'
import type { WalletServices } from './services/index.ts'

/** A program's result with its typed refusal as a value; defects still reject. */
export type WalletResult<A> = { ok: true; value: A } | { ok: false; failure: WalletFailure }

/**
 * The one door from Promise code (the router, the MCP handlers) into Effect programs: provides the services and runs
 * to a promise. Nothing else in the Worker calls `Effect.runPromise`.
 */
export function runWallet<A>(
  program: Effect.Effect<A, WalletFailure, WalletServices>,
  layer: Layer.Layer<WalletServices>,
): Promise<WalletResult<A>> {
  return Effect.runPromise(
    program.pipe(
      Effect.match({
        onSuccess: (value): WalletResult<A> => ({ ok: true, value }),
        onFailure: (failure): WalletResult<A> => ({ ok: false, failure }),
      }),
      Effect.provide(layer),
    ),
  )
}
