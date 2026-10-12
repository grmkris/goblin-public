# ADR 0045: Goblin Wallet, an agent's wallet with limits the owner sets

(first-class servers) and ADR 0044 (spending rules), and is the "Agentic Wallet" both name.

An agent that buys search, hires specialists and funds outside services needs money it can spend without the owner
approving every cent, and an owner who can see, at a glance, what it bought, what is left and what stops it. Mercator
brings its own wallet for its own jobs; nothing lets goblin, or any other MCP client, pay an x402 or MPP service, move
funds between chains or fund Mercator within limits the owner chose.

## Decision

**Goblin Wallet is its own MCP server, built in this monorepo but deployed as its own Worker with its own sign-in and
stage** (`apps/wallet`, `apps/wallet-web`, `packages/wallet`; dev at `wallet-dev.goblin.surf`). goblin owns the
workspace, approvals of calls and its own spending rules; the wallet owns financial authority: accounts, limits,
signing and receipts. Any MCP client can connect it; goblin connects it as a first-class server (ADR 0043).

**The owner signs in with Privy** (email or Google), which gives them an embedded EVM wallet: the owner's account. The
wallet then creates the **agent signer**: a Privy server wallet the owner owns, on which this service is an additional
signer bound to a Privy policy. MCP OAuth (dynamic client registration, PKCE, resource-bound tokens, rotating refresh
tokens) is a port of Sidequest's, with its consent page in the wallet's web app.

**Every limit names the layer that enforces it.** There are five, and each can only narrow the next:
- **On-chain allowance.** The owner's account is upgraded with EIP-7702 to MetaMask's `EIP7702StatelessDeleGator`
  (the owner signs, our relay sends the type-4 transaction) and signs an ERC-7710 delegation to the agent signer with
  `ERC20PeriodTransfer` (e.g. 20 USDC an hour), transfer-only to the agent, with an expiry. The agent tops itself up just
  in time. MetaMask's v1.3.0 contracts sit at the same addresses on Ethereum, Base, Arbitrum and Tempo.
- **Tempo access key.** On Tempo, a keychain access key with a per-token periodic limit and an expiry, when the spike
  proves Privy can act as the root key; otherwise the signer policy and the ledger enforce Tempo spends.
- **Signer policy.** Privy refuses what the policy does not allow: USDC payment authorizations above the per-payment
  cap, contracts and methods outside the list, any key export. The policy is owned by an admin key that never leaves
  the owner's machine, so the Worker cannot widen it.
- **Wallet ledger.** Per call, per hour and per week (defaults $5, $20, $50, for 7 days), an allowlist of paid services
  and an address book. Every spend is an operation with frozen terms, reserved against the ledger before anything is
  signed, idempotent by its operation id.
- **Client rule.** goblin's own spending rule for the wallet's `paid_fetch` (ADR 0044), which never widens the wallet's.

**Spends that cross a limit, or pay a recipient or service the owner has not seen, ask the owner** through a URL
request (MCP 2026, ADR 0042) to the wallet's own Approve page. The page shows the frozen terms, rebuilds their hash,
and the owner decides there, signed in with Privy. An App's button never approves a spend.

**The wallet pays services over x402 and MPP.** `paid_fetch(service, args, max_usd, operation_id)` fetches the
service's challenge, picks an allowed rail (x402 on Base, or MPP on Tempo, both offered by Exa search), checks the price
against `max_usd` and the limits, pays, makes the request and returns it bounded, with a receipt. Mercator stays its
own server with its own wallet: a client composes the two, reading Mercator's status and calling the wallet's `bridge`
or `transfer` to fund the Tempo address Mercator reports.

**The wallet's UI is an MCP App** (a dashboard and a receipt view), with text fallbacks for clients that render none,
and a global entrypoint so goblin can put the wallet in its navigation.

## Rejected

- **The wallet inside goblin's agent.** Financial authority would share an origin and a runtime with an agent that runs
  untrusted tools; ADR 0043 already keeps outside work in servers.
- **Privy's gas sponsorship on the owner's account.** It upgrades the account with its own EIP-7702 implementation,
  which would replace MetaMask's delegator; our relay sends the upgrade instead.
- **Proxying Mercator through the wallet.** It doubles Mercator's own authority and limits; the client composes them.
- **`workers-oauth-provider`.** It rejects ids with `:`, which every Privy id has, and Sidequest's server already works
  with goblin's client.
- **A generic signing tool.** Nothing signs arbitrary data or transactions; every signature belongs to an operation with
  frozen terms.

## Consequences

- A second Worker, sign-in and stage to run; `scripts/wallet-stage.ts` deploys it without touching goblin's releases.
- The owner API is a Schema route table rather than HttpApi, to build it in one night.
- Hosted signing works only while Privy and its policy allow it; revoking the signer in Privy, the delegation on-chain
  and the grant in the wallet are three different stops, and the wallet shows which ones are in place.
- Solana, a common budget with Sidequest's own agent wallets, and more bridges come later.
