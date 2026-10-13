# 0054: Pro paid as a signed USDC subscription

Accepted 2026-10-12 with the owner (Kris), for the night's build. Amended 2026-10-13 with the owner: Pro is paid by a
day pass or monthly at the deployment's prices, and there is no free plan (see the end). The plan is
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
- at most the price per period (ERC20PeriodTransfer): monthly's first period starts a minute before it was prepared, a
  day pass's at the UTC midnight that begins the signing day;
- nothing after the last whole period within 12 months of 365/12 days (Timestamp): 360 days and 12 payments monthly,
  365 days for the day pass.

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

**goblin's renewals (monthly).** `app_billing_wallet_subscriptions` (auth D1) keeps each subscription of an account,
keyed by subscription. The plan source `wallet` gives Pro through the last period paid, and through the grace while a
failed renewal is retried.
- Return from signing: goblin reads the subscription (its reference must be the account's), collects the current
  period with the operation id `<billing>:<subscription>:<period>` and activates Pro, answering the receipt.
- The hourly cron: three days before a payment a reminder ("Add $X" when the wallet says the owner lacks it,
  `shortUsd`, never the balance itself), then the payment when due; a failed one starts a seven-day grace with a daily
  retry, then the account has no plan.
- Cancelling is the owner's own `disableDelegation` UserOperation from the wallet's Home or Limits, its gas in their
  USDC, checked in the page before they sign it (`reviewOwnerCalls`). Pro runs to the end of the paid period; goblin
  learns of it at the next reminder or collection.
- Notices (reminder, receipt, failure, end) reach the owner's Personal, Activity and Telegram through the agent's
  internal `/internal/billing-notice`, which needs no plan.

**The card checkout is off behind a flag.** `GOBLIN_CARD_CHECKOUT` (binding `CARD_CHECKOUT`, default `off`): checkout
and the portal answer `card_disabled`, and the web hides them. The Dodo code, webhook and cron stay for when it comes
back.

**Any call that needs Pro asks once.** The web's query client hands every `SubscriptionRequired` to one upgrade prompt
(`lib/upgrade-prompt.ts`), which names the feature when the error does and offers See Pro, back to the page.

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

## Amended 2026-10-13: a day pass or monthly, and no free plan

Kris decided the pricing on the night of 2026-10-13. The spec is `/tmp/goblin-lanes-20261012/basic-v2-spec.md`.

**One plan, two ways to pay.** goblin Pro is the only plan: 800 Credits a day, hand-overs, subagents and routines. It
is paid from the Goblin Wallet, signed once as above, by:
- **`day`, the day pass**: $1 for each UTC day the owner uses goblin. Its delegation caps $1 a one-day period from the
  UTC midnight of the signing day, for 365 days.
- **`month`**: $15 every 30 days, for 12 payments, renewed by the hourly cron with the reminder, daily retry and
  seven-day grace above.

The entitlement is `plan: 'pro'` whichever way it is paid; `billing: 'day' | 'month'` says how
(`BillingState.wallet.billing`, `AccountPlan.billing`). The merchant request carries `plan: 'pro'`, `billing`, the
amount and period, and `months: 12`; the wallet answers `billing` back.

**Prices are a deployment setting.** `GOBLIN_PLAN_CATALOG` (binding `PLAN_CATALOG`) is JSON `{ day?, month? }`, each any
of `amountUsd` (0.01 to 999.99, two decimals), `periodDays` (the day pass's is 1; monthly's 1 to 30) and `dailyCredits`
(0 to 10,000) over the defaults in `billing/plans.ts`. The schema is `PlanCatalogSetting` in `@goblin/contracts`;
Alchemy refuses to deploy a setting that does not decode, and the runtime keeps the defaults for one. `BillingState`
lists the catalog, the day pass first, so the web shows the deployment's prices. A new subscription asks for the
catalog's terms; one already signed keeps what was signed.

**The day pass is collected as it is used, never by the cron.** Confirming it (`POST /api/billing/wallet/confirm`)
turns Pro on and takes nothing, unless the wallet already says the owner lacks a day's payment (`payment_short`). The
first owner turn of a UTC day that `Budget.admit` admits (the composer, Telegram, a Persona, an inbound client's ask)
takes that day's payment in the background (`billing/day-pass.ts` `payToday`, through `Entitlements.payDay`), so the
answer never waits for it; the agent claims the day in memory so it asks once, and asks again only after a payment
still landing or a wallet it could not reach. A tool's own budget check (`Budget.open`) and routine runs never pay a
day, so an idle day costs nothing. The period is the UTC days since `startsAt`'s day, plus one, as the wallet counts
it.
- A day the wallet is short lapses the pass from the next message on (no reminder, no grace): the turn is refused
  with `SubscriptionRequired` and the web offers the wallet's Add funds. Confirming the pass again takes that day's
  payment, and Pro is on once it is paid.
- Revoked, or past its last day, the pass is cancelled and runs to the end of the last day paid. A failure of the
  chain or the wallet leaves it on, and the next message tries again; `expired` for a day that ended unpaid (a message
  just before midnight) is told apart by reading the subscription.
- `WalletPlan.paidThrough` is the end of the last day paid, null before the first; `nextPaymentAt` is null.
- Day passes send no notices; each payment shows in the wallet's Activity.

**Moving from the day pass to monthly.** A day-pass owner may start monthly (any other start while Pro is on is
`already_subscribed`). The two subscriptions sit side by side until monthly's first payment lands; then the day pass
is `superseded`: nothing more is taken from it, and nothing is revoked on chain (the owner may revoke it in the
wallet). Migration `0012_wallet_billing` keys `app_billing_wallet_subscriptions` by subscription and adds `billing`;
rows before it are monthly.

**No free plan.** `GOBLIN_FREE_DAILY_CREDITS`, `GOBLIN_FREE_WALLET_USD` and the funded-wallet check are gone; a stage
that still sets them ignores them. Without a plan the day's allowance is none, and every budget check and turn is
refused with `SubscriptionRequired` `feature: 'chat'`. The Worker edge no longer reads the plan: an owner without one
reaches their own agent, so Start, Connections, Settings and billing work before Pro is chosen (the wallet's sign-in
callback included). The agent refuses what needs Pro where it happens: a turn (`Budget.admit`), routines and their
Telegram copies and reminders, Events, a decision on a held call, a Persona's reply, app powers and background work
that spends Credits. Kris's own account keeps its operator override.

Consequences:
- A day-pass payment that lands just after midnight is counted by the chain against the next day, which can give two
  days for $1; the chain still never takes more than $1 a day.
- A day pass prepared at 23:59 UTC and signed after midnight starts the day before, so its first payment can be
  period 2.
- The first message of a day is answered even when its payment then fails; the next one is refused.
- Verified by unit tests (`entitlements`, `wallet-billing`, `budget-native`, `auth-migrations`, the edge and owner API
  tests) and typecheck, lint, Effect diagnostics and Knip. Not run: workerd integration tests and the flow on dev.
