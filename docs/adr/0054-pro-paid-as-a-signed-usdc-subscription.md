# 0054: Pro paid as a signed USDC subscription

Accepted 2026-10-12 with the owner (Kris), for the night's build. The plan is
`/tmp/goblin-mysi-usdc-subscription-plan-20261012.md`. It builds on ADR 0015 (plans and payments, amended below for the
card flag), 0045 (Goblin Wallet), 0049 (top-ups from the wallet) and 0050 (gas in USDC through UserOperations).

## Context

Pro was a card subscription through Dodo (ADR 0015), which was never configured: `DODO_*` is empty on dev and prod.
Every goblin owner already keeps a Goblin Wallet with USDC on Base, an account upgraded to MetaMask's DeleGator
(EIP-7702) and the ERC-7710 delegations the agent's allowance is made of. The owner decided that Pro is paid from that
wallet: $10 in USDC every 30 days, as a permission they sign once, which the chain enforces and they revoke to cancel.

## Decision

**The subscription is one delegation the owner signs once.** It goes from the owner's 7702-upgraded account to
goblin's **collector**, with the allowance's caveats and the collector in the agent's place
(`packages/wallet/src/delegation/subscription.ts`):
- USDC `transfer` only (AllowedTargets, AllowedMethods, no value);
- the recipient pinned to the collector itself (AllowedCalldata at offset 4), so the money lands in the collector;
- at most $10 per 30-day period (ERC20PeriodTransfer), the first period starting a minute before it was prepared;
- nothing after 12 periods, 360 days (Timestamp), so at most 12 payments can ever be taken.

The wallet's sign page (`/subscribe/:id`) rebuilds the delegation from the terms it shows (owner, collector, amount,
period, number of periods) and compares hashes before Privy's screen (`reviewSubscription`, as `reviewAllowance`
does). The owner's account must be upgraded on Base first: the DeleGator is what checks the signature at redemption.

**The collector is a Privy server wallet the project's admins own, one per stage.** Its owner is the policy-admin key
quorum; the wallet Worker's routine signer is its only additional signer, held to the collector policy
(`collectorPolicy` in `packages/wallet/src/policy`): UserOperations that redeem on the DelegationManager and approve
Pimlico's ERC-20 paymaster for at most the gas ceiling, its own EIP-7702 upgrade to the DeleGator, export denied. Its
first collection carries its 7702 authorization, as an agent's first operation does. It pays its gas in USDC from a
small float of its own. `packages/wallet/scripts/create-collector.ts` writes the policy document and creates it; the
conductor runs it by hand.

**The wallet keeps the subscription; goblin is a merchant of the wallet.** A merchant API under `/api/merchant/*`,
server to server with goblin's bearer merchant key (one per stage), creates a request, reads it and collects a period
(`packages/wallet/src/contract/merchant.ts`). Requests, signed delegations and one collection row per period live in
the `WalletAuth` singleton beside OAuth (`apps/wallet/src/merchant/store.ts`): a request is made before any owner is
known, and the merchant finds it by id. The first signed-in owner to open a request is bound to it, as a consent
request is. A return address must be on one of the merchant's allowed origins; the sign page goes back there.

**A collection is at most one payment a period, whatever the operation id.** The wallet reads the chain first:
`disabledDelegations` (revoked), the enforcer's `getAvailableAmount` (a period already paid by an earlier attempt
counts as paid) and the owner's USDC (short is `insufficient_funds`; nothing is signed then). Then the collector
redeems the period's amount in one UserOperation. A submitted operation is checked against the bundler on the next
call; one with no receipt after 15 minutes is tried again, and the enforcer refuses a second payment in the period.

**goblin's renewals.** `app_billing_wallet_subscriptions` (auth D1) keeps each account's subscription. The plan source
`wallet` gives Pro through the last period paid, and through the grace while a failed renewal is retried.
- Return from signing: goblin reads the subscription (its reference must be the account's), collects the current
  period with the operation id `pro:<user>:<period>` and activates Pro, answering the receipt.
- The hourly cron: three days before a payment a reminder ("Add $X" when the wallet says the owner lacks it,
  `shortUsd`, never the balance itself), then the payment when due; a failed one starts a seven-day grace with a daily
  retry, then the account falls back to free.
- Cancelling is the owner's own `disableDelegation` UserOperation from the wallet's Home or Limits, its gas in their
  USDC, checked in the page before they sign it (`reviewOwnerCalls`). Pro runs to the end of the paid period; goblin
  learns of it at the next reminder or collection.
- Notices (reminder, receipt, failure, end) reach the owner's Personal, Activity and Telegram through the agent's
  internal `/internal/billing-notice`, which needs no plan.

**The card checkout is off behind a flag.** `GOBLIN_CARD_CHECKOUT` (binding `CARD_CHECKOUT`, default `off`): checkout
and the portal answer `card_disabled`, and the web hides them. The Dodo code, webhook and cron stay for when it comes
back.

**Any call that needs Pro asks once.** The web's query client hands every `SubscriptionRequired` to one upgrade prompt
(`lib/upgrade-prompt.ts`), which names the feature when the error does and offers See Pro, back to the page. It asks
only an account on a plan; one without any plan is on its page's subscribe gate already.

## Consequences

- goblin's money lands in the collector, which only the admins can move out; the Worker can only redeem into it.
- A lapsed account's old delegation is still valid on chain until it expires or the owner revokes it; goblin never
  collects from a subscription it no longer keeps, and subscribing again signs a new one.
- Verified: typecheck, lint, Effect diagnostics and Knip. Not run yet: unit or workerd tests, and the flow on dev
  (the collector, its float and policy, the merchant key and a real subscription on Base mainnet).

## Considered options

- **A key in Worker secrets as the collector.** Rejected: a Privy server wallet the admins own keeps the money out of
  the Worker's reach, and its policy bounds what the Worker can make it sign.
- **Pulling each period with an x402 or EIP-3009 authorization the owner signs every month.** Rejected: the point is to
  sign once and cancel on-chain.
- **A per-owner store in the ledger Durable Object.** Rejected for the request, which exists before its owner does; the
  singleton beside OAuth serves both the merchant (by id) and the owner (by binding).
