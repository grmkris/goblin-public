import type { Address, AgentSigner } from '@goblin/wallet/contract'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { failure, type WalletFailure } from './errors.ts'

/** The owner's agent signer (lane S): one Privy server wallet the owner owns. Absent until onboarding made it. */
export class Signer extends Context.Service<
  Signer,
  {
    /** The agent wallet's address, when onboarding created it. */
    readonly address: Effect.Effect<Address | undefined>
    /** The signer, or the refusal telling the model the owner has not set the wallet up. */
    readonly require: Effect.Effect<AgentSigner, WalletFailure>
  }
>()('goblin/wallet/Signer') {}

export const signerLayer = (signer: AgentSigner | undefined): Layer.Layer<Signer> =>
  Layer.succeed(Signer, {
    address: Effect.succeed(signer?.address),
    require:
      signer === undefined
        ? Effect.fail(
            failure(
              'not_onboarded',
              'The owner has not created the agent wallet yet.',
              409,
              'Ask the owner to finish setup in the wallet app.',
            ),
          )
        : Effect.succeed(signer),
  })
