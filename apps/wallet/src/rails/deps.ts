import * as Data from 'effect/Data'
import type { EvmChain, JsonRpc, TopUp } from '@goblin/wallet/balances'
import type { ChainKey, ChainSetup, AgentSigner } from '@goblin/wallet/contract'

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

/** A trigger's request to the owner's ledger: check the Tempo float after `delayMs`, fitting a payment of `need` USD. */
export interface FloatSchedule {
  readonly delayMs: number
  readonly need?: string | undefined
}

/**
 * The Tempo float's single flight, kept by the owner's ledger (ADR 0051): whether a refill is in flight or paused after
 * failures, and how to ask its alarm for one. Absent where nothing refills (tests, unconfigured deployments).
 */
export interface FloatHooks {
  readonly state: () => Promise<{ readonly refilling: boolean; readonly pausedUntil?: string | undefined }>
  readonly schedule: (request: FloatSchedule) => Promise<void>
}

/**
 * Everything the rails need from the rest of the wallet. The Worker wiring builds this once per request: the ledger
 * answers `profile`, lane S's delegation code answers `topUp` and `allowances`, the Worker's Pimlico key the bundler.
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
  readonly rpcFor: (chain: ChainKey) => JsonRpc
  /** Pimlico's bundler per chain (ERC-4337, gas paid in USDC); absent where no key is configured. */
  readonly bundlerFor?: (chain: ChainKey) => JsonRpc
  readonly fetchFn?: typeof fetch
  readonly now?: () => Date
  /** The Tempo float's refills: asked for after an MPP payment leaves it low, or when one is refused for funds. */
  readonly float?: FloatHooks
  /** Receipt polling; tests make it instant. */
  readonly wait?: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> }
}

/** A rail refusal with a message for the owner and the model; no money moved. */
export class RailError extends Data.TaggedError('RailError')<{ readonly message: string }> {
  constructor(message: string) {
    super({ message })
  }
}
