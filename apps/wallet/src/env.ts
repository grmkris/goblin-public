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
  /** Pimlico's bundler and ERC-20 paymaster: every EVM send is a UserOperation whose gas is paid in USDC. */
  readonly PIMLICO_API_KEY: string
  /** JSON object of chain id to RPC URL; empty means the public RPCs in `@goblin/wallet/chains`. */
  readonly RPC_URLS: string
  /** "1" lets the wallet spend mainnet money; anything else is testnets only. */
  readonly WALLET_LIVE: string
  /**
   * Secret: goblin's merchant key (ADR 0054), the bearer of `/api/merchant/*`; empty turns the merchant API off. goblin
   * holds the same value as `GOBLIN_WALLET_MERCHANT_KEY`.
   */
  readonly WALLET_MERCHANT_GOBLIN_KEY: string
  /** Comma-separated origins goblin's subscription requests may return the owner to (`https://goblin.surf`, …). */
  readonly MERCHANT_RETURN_ORIGINS: string
  /** Plain: goblin's collector, the Privy server wallet subscriptions pay into; empty until it is created. */
  readonly COLLECTOR_WALLET_ID: string
  readonly COLLECTOR_ADDRESS: string
}
