# 0047: Inference paid per call from the owner's wallet

It builds on ADR 0026 (Credits), 0043 (first-class servers), 0044 (spending rules) and 0045 (Goblin Wallet). Amended the
same day: a pay mode replaces paid model picks, and the default is Credits first, then the wallet (below). Amended
2026-10-13: there is no free plan, so the funded-wallet rule below is gone (ADR 0054, amended).

## Context

goblin pays for its own model calls: a Token Plan subscription behind LiteLLM, metered per account in Credits. The
owner wants an account to be able to pay for its inference itself, from its Goblin Wallet, with machine payments.

Tempo runs an MPP proxy that sells our default model, DeepSeek V4.1 Flash, per request. It answers 402 with a `tempo`
charge in USDC.e on chain 4217, priced up front from the request's `max_tokens` and prompt. MPP also offers sessions,
which bill per token as an answer streams. Neither the wallet nor the proxy supports them yet.

## Decision

**A model call can pay its own way.** The deployment sells paid routes through `PAID_INFERENCE`:
- `goblin`: goblin's own endpoint behind an MPP charge, serving the model the owner picked under its own id;
- `tempo`: Tempo's proxy, serving its DeepSeek whatever model is picked.

A paid call works like this:
1. It goes out with no key of goblin's.
2. A 402's challenge is paid by the owner's Goblin Wallet.
3. The same request is sent once more with `Authorization: Payment <credential>`.

**The owner's pay mode says when a call is paid** (amended 2026-10-12). The model pick stays a model. The pay mode is
one of:
- `credits-then-wallet` (the default): the day's Credits pay first; once they are spent, each call is paid from the
  wallet while it can pay (connected, its payment tool allowed to run without asking);
- `credits`: calls stop at the day's limit;
- `wallet`: every call is paid from the wallet.

It comes with a route, `goblin` by default. The decision is made before each model call, so a turn whose Credits run
out midway goes on paid. A turn is admitted past the Credits in `wallet` mode, and in `credits-then-wallet` while the
wallet can pay. An account that had picked `paid:goblin` or `paid:tempo` as its model got the `wallet` mode on that
route, and its model pick went back to the stage's default (migration `20261031000300_pay_mode`).

**Billing is per call, priced up front, for now.** Each call pays one charge sized from its tokens. True per-token
billing waits for MPP sessions in the wallet and on goblin's side.

**The wallet pays through a dedicated caller.**
- The runtime calls the wallet's payment tool (`pay_challenge`, named by its first-class profile's `payment`) as the
  MCP caller `inference`.
- That caller reaches only that tool. The model never sees it: the server keeps it App-only, and goblin treats
  `inference` as an App for visibility.
- Grants and ask-first still apply.
- Choosing a pay mode that uses the wallet is the owner's standing consent. The wallet's own limits, and goblin's $0.05
  per call, are the caps.

**A paid call costs no Credits.** Its responses are not recorded against the day. Only the owner's conversations
(main, threads, Personas, subagents) follow the pay mode; routines and housekeeping stay on Credits, and are refused
once the day's Credits are spent.

## Consequences

- **A refused payment becomes the provider's 402**, carrying the wallet's refusal code and words ("Payment from your
  Goblin Wallet failed (insufficient_funds): your Goblin Wallet needs USDC.e on Tempo: …"). The model client neither
  retries it nor reports it as a connection error. The words reach only the owner's chat; the run ledger keeps the
  code alone (`payment_refused:<code>`), and the chat tells an empty wallet apart so it can offer to fund it. Since
  ADR 0051 the wallet refills the agent's Tempo float from the owner's Base allowance; while a refill is on its way it
  answers `insufficient_funds` with "Refilling from your Base allowance; try again in about a minute." and
  `retryAfterSeconds`. A service
  that answers the paid request with another 402 ends the call the same way (`refused_after_payment`), never paying
  again.
- **Paid streams make no client retries.** Each send is a new charge.
- **The wallet settles on the receipt.** It holds a paid call as unknown until goblin reports the answer's
  `Payment-Receipt` under the same operation id, which goblin does while the answer streams; the wallet checks it on
  chain. A report that fails leaves the payment unknown in the wallet, never paid twice.
- **A turn Pi runs again pays again.** A payment is keyed by its challenge, and a re-run gets a new challenge.
- **Charges are up front.** At goblin's 32,768-token output cap, a call through the proxy costs about $0.02, whatever
  the answer uses.
- **Paying per call needs a plan.** Until 2026-10-13 a free plan's Credits asked for a funded wallet
  (`GOBLIN_FREE_WALLET_USD`). There is no free plan now (ADR 0054, amended): an account without Pro is refused a turn
  before the pay mode is read, so its wallet pays for nothing either.

## Rejected

- **Paid routes as model picks** (the first version). The owner had to choose between a model and a way to pay, and a
  day whose Credits ran out stopped goblin even with a wallet ready to pay.
- **The wallet fetching the model call (`paid_fetch`).** It doesn't stream, its body is capped, and it is limited to
  allow-listed services.
- **A generic signing tool in the wallet.** ADR 0045 rejects one. `pay_challenge` pays only allow-listed origins and
  recipients.
- **Sessions before the deadline.** Neither side had them.
