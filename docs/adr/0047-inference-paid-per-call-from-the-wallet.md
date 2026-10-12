# 0047: Inference paid per call from the owner's wallet

It builds on ADR 0026 (Credits), 0043 (first-class servers), 0044 (spending rules) and 0045 (Goblin Wallet).

## Context

goblin pays for its own model calls: a Token Plan subscription behind LiteLLM, metered per account in Credits. The
owner wants an account to be able to pay for its inference itself, from its Goblin Wallet, with machine payments.

Tempo runs an MPP proxy that sells our default model, DeepSeek V4.1 Flash, per request. It answers 402 with a `tempo`
charge in USDC.e on chain 4217, priced up front from the request's `max_tokens` and prompt. MPP also offers sessions,
which bill per token as an answer streams. Neither the wallet nor the proxy supports them yet.

## Decision

**A model call can pay its own way.** The owner picks a paid route in the model picker:
- `paid:tempo`: Tempo's proxy;
- `paid:goblin`: goblin's own endpoint behind the same MPP charge.

The deployment offers these through `PAID_INFERENCE`. A paid call works like this:
1. It goes out with no key of goblin's.
2. A 402's challenge is paid by the owner's Goblin Wallet.
3. The same request is sent once more with `Authorization: Payment <credential>`.

**Billing is per call, priced up front, for now.** Each call pays one charge sized from its tokens. True per-token
billing waits for MPP sessions in the wallet and on goblin's side.

**The wallet pays through a dedicated caller.**
- The runtime calls the wallet's payment tool (`pay_challenge`, named by its first-class profile's `payment`) as the
  MCP caller `inference`.
- That caller reaches only that tool. The model never sees it: the server keeps it App-only, and goblin treats
  `inference` as an App for visibility.
- Grants and ask-first still apply.
- Picking a paid route is the owner's standing consent. The wallet's own limits, and goblin's $0.05 per call, are
  the caps.

**A paid call costs no Credits.** The budget lets a paid pick through, and its responses are not recorded against the
day. Routines and housekeeping stay on goblin's own models: a paid pick stands in as the model goblin pays for.

## Consequences

- **A refused payment becomes the provider's 402**, carrying the wallet's words ("Payment from your Goblin Wallet
  failed: …"). The model client neither retries it nor reports it as a connection error.
- **Paid streams make no client retries.** Each send is a new charge.
- **A turn Pi runs again pays again.** A payment is keyed by its challenge, and a re-run gets a new challenge.
- **Charges are up front.** At goblin's 32,768-token output cap, a call through the proxy costs about $0.02, whatever
  the answer uses.
- **The free plan's Credits ask for a funded wallet.** Where the stage sets `GOBLIN_FREE_WALLET_USD` (5 on dev and
  prod), a free account's 50 Credits a day apply only while its Goblin Wallet holds that much in USDC and USDC.e.

## Rejected

- **The wallet fetching the model call (`paid_fetch`).** It doesn't stream, its body is capped, and it is limited to
  allow-listed services.
- **A generic signing tool in the wallet.** ADR 0045 rejects one. `pay_challenge` pays only allow-listed origins and
  recipients.
- **Sessions before the deadline.** Neither side had them.
