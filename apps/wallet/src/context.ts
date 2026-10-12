import type { AgentSigner } from '@goblin/wallet/contract'
import type { WalletEnv } from './env.ts'
import { ledgerClient } from './ledger/durable.ts'
import { failure } from './services/errors.ts'
import type { WalletParts } from './services/index.ts'
import type { RailsPort } from './services/rails.ts'

/** Who a request acts for: the Privy user whose ledger it touches. */
export interface Owner {
  readonly userId: string
}

/** The pieces other lanes provide: the owner's agent signer (lane S) and the payment rails (lane D). */
export interface Wiring {
  /** The owner's ledger Durable Object. */
  readonly ledger: (env: WalletEnv, owner: Owner) => { fetch(request: Request): Promise<Response> }
  readonly signer: (env: WalletEnv, owner: Owner) => Promise<AgentSigner | undefined>
  readonly rails: (env: WalletEnv, owner: Owner, signer: AgentSigner | undefined) => RailsPort
}

const unavailable = (): Promise<never> =>
  Promise.reject(failure('rails_not_configured', 'The payment rails are not configured on this deployment.', 503))

/** Rails that refuse everything; the deployment uses real ones once lane D's code is wired. */
export const unconfiguredRails: RailsPort = {
  quotePaidFetch: unavailable,
  payPaidFetch: unavailable,
  quoteTransfer: unavailable,
  transfer: unavailable,
  swapQuote: unavailable,
  swapExecute: unavailable,
  bridgeQuote: unavailable,
  bridgeExecute: unavailable,
  balances: unavailable,
  allowances: unavailable,
  upgrade: unavailable,
}

export const defaultWiring: Wiring = {
  ledger: (env, owner) => env.LEDGER.getByName(owner.userId),
  signer: () => Promise.resolve(undefined),
  rails: () => unconfiguredRails,
}

/** One owner's services for one request: their ledger Durable Object, signer and rails. */
export async function partsFor(env: WalletEnv, owner: Owner, origin: string, wiring: Wiring): Promise<WalletParts> {
  const signer = await wiring.signer(env, owner)
  return {
    ledger: ledgerClient(wiring.ledger(env, owner)),
    signer,
    rails: wiring.rails(env, owner, signer),
    origin,
  }
}
