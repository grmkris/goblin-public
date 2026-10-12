/** The Worker's bindings. Declare each one here and in `alchemy.run.ts` together. */
export interface WalletEnv {
  readonly ASSETS: Fetcher
  readonly LEDGER: DurableObjectNamespace
  readonly AUTH: DurableObjectNamespace
  /** Plain: the Privy app id the browser needs, served at `GET /api/config`. */
  readonly PRIVY_APP_ID: string
  readonly PRIVY_SIGNER_ID: string
  readonly PRIVY_POLICY_ID: string
  /** Secrets: never logged, never in a response. */
  readonly PRIVY_APP_SECRET: string
  readonly PRIVY_AUTHORIZATION_KEY: string
  readonly RELAY_PRIVATE_KEY: string
  /** JSON object of chain id to RPC URL; empty means the public RPCs in `@goblin/wallet/chains`. */
  readonly RPC_URLS: string
  /** "1" lets the wallet spend mainnet money; anything else is testnets only. */
  readonly WALLET_LIVE: string
}
