import type { AllowanceConfirm, AllowancePrepare, AgentSigner, Address, ChainSetup } from '@goblin/wallet/contract'
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
/** The owner's allowance, built and verified by the delegation code (lane S) when it is wired. */
export interface AllowancePort {
  /** The exact ERC-7710 delegation for the owner to sign; the browser rebuilds and compares it. */
  prepare(
    env: WalletEnv,
    owner: Owner & { address: Address; agent: Address },
    request: typeof AllowancePrepare.Type,
  ): Promise<{
    typedData: unknown
    delegationHash: string
  }>
  /** Verifies the owner's signature and stores the delegation where the agent redeems it from. */
  confirm(
    env: WalletEnv,
    owner: Owner & { address: Address; agent: Address },
    request: typeof AllowanceConfirm.Type,
  ): Promise<NonNullable<ChainSetup['allowance']>>
}

export interface Wiring {
  /** Creates the owner's agent wallet once (lane S's Privy code) and says where it is. */
  readonly createAgent: (
    env: WalletEnv,
    owner: Owner & { address: Address },
  ) => Promise<{ address: Address; walletId: string }>
  readonly allowance: AllowancePort
  /** The owner's ledger Durable Object. */
  readonly ledger: (env: WalletEnv, owner: Owner) => { fetch(request: Request): Promise<Response> }
  readonly signer: (env: WalletEnv, owner: Owner) => Promise<AgentSigner | undefined>
  readonly rails: (env: WalletEnv, owner: Owner, signer: AgentSigner | undefined) => RailsPort
  /** Outbound fetch for keyless third-party APIs (Relay deposit addresses); tests inject one, production uses `fetch`. */
  readonly fetchFn?: typeof fetch | undefined
}

const unavailable = (): Promise<never> =>
  Promise.reject(failure('rails_not_configured', 'The payment rails are not configured on this deployment.', 503))

/** Rails that refuse everything; the deployment uses real ones once lane D's code is wired. */
export const unconfiguredRails: RailsPort = {
  quotePaidFetch: unavailable,
  payPaidFetch: unavailable,
  payChallenge: unavailable,
  confirmChallenge: unavailable,
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

const notConfigured = (what: string) => (): Promise<never> =>
  Promise.reject(failure('not_configured', `${what} is not configured on this deployment.`, 501))

export const defaultWiring: Wiring = {
  createAgent: notConfigured('The agent wallet'),
  allowance: { prepare: notConfigured('The allowance'), confirm: notConfigured('The allowance') },
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
