import * as Data from 'effect/Data'
import type { EvmChain, JsonRpc, TopUp } from '@goblin/wallet/balances'
import type { ChainKey, ChainSetup, AgentSigner } from '@goblin/wallet/contract'
import type { RelaySender } from '@goblin/wallet/relay'

/** What the wallet knows of its owner: written by onboarding, read from the ledger. */
export interface RailsProfile {
  readonly ownerAddress?: string | undefined
  readonly agentAddress?: string | undefined
  readonly chains: readonly ChainSetup[]
}

/** The owner's stored ERC-7710 allowance on one chain: what the enforcer needs to report what is left. */
export interface StoredAllowance {
  readonly chain: EvmChain
  readonly delegationHash: string
  /** The ERC20PeriodTransfer caveat terms the owner signed. */
  readonly terms: string
  readonly expiresAt: string
}

/**
 * Everything the rails need from the rest of the wallet. The Worker wiring builds this once per request: the ledger
 * answers `profile`, lane S's delegation code answers `topUp` and `allowances`, the Worker's secrets make the relay.
 */
export interface RailsDeps {
  /** Mainnets when true (`WALLET_LIVE=1`), their testnets otherwise. Tokens, RPCs and explorers follow it. */
  readonly live: boolean
  /** The owner's agent signer; absent until onboarding made the agent wallet. */
  readonly signer: AgentSigner | undefined
  readonly profile: () => Promise<RailsProfile>
  /** How the agent redeems the owner's allowance on a chain, or undefined when none is set up. */
  readonly topUp?: (chain: EvmChain) => Promise<TopUp | undefined>
  readonly allowances?: () => Promise<readonly StoredAllowance[]>
  /** Sends the owner's EIP-7702 upgrade; absent where no relay key is configured. */
  readonly relay?: Pick<RelaySender, 'upgrade'>
  readonly rpcFor: (chain: ChainKey) => JsonRpc
  readonly fetchFn?: typeof fetch
  readonly now?: () => Date
  /** Receipt polling; tests make it instant. */
  readonly wait?: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> }
}

/** A rail refusal with a message for the owner and the model; no money moved. */
export class RailError extends Data.TaggedError('RailError')<{ readonly message: string }> {
  constructor(message: string) {
    super({ message })
  }
}
