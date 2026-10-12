# 0051: The Tempo float, refilled from the Base allowance

Accepted 2026-10-12 with the owner ("one balance"). It amends ADR 0045 (Goblin Wallet) and ADR 0047 (inference paid
from the wallet), and builds on ADR 0050 (UserOperations).

## Context

The owner funds USDC on Base and signs an ERC-7710 allowance to the agent there. Every Base spend redeems what it
lacks from that allowance in the same UserOperation. But paid inference and MPP services are paid through
`pay_challenge` on Tempo, from the agent's own USDC.e, and nothing moved money from Base to Tempo: the wallet told the
owner to send USDC.e by hand, or `add_funds` gave a deposit address someone had to pay. A wallet set up end to end
could not pay goblin's model.

## Decision

**One balance.** The wallet keeps the agent's Tempo USDC.e, the *float*, topped up from the Base allowance, within the
owner's limits.

- **The rule** (`@goblin/wallet/bridge` `planRefill`, table-tested). Below $1.00, or below a charge that must fit, the
  float is refilled to $3.00 (or to that charge), in whole cents. The refill is capped by what the allowance releases
  this period, up to the owner's Base USDC, plus the agent's own Base USDC, less the Base gas ceiling ($0.10). It never
  passes the policy's $5 route cap. A capped refill under $0.50 is skipped, not sent. It lands short of the target by
  Relay's fee (about 1%).
- **The move.** One UserOperation from the agent on Base: redeem the shortfall and its gas from the allowance, approve
  exactly the amount to Relay's depository, deposit it for the agent's own Tempo address, approve the paymaster for the
  gas. Relay delivers USDC.e on Tempo. The Privy policy as it stands allows every call of that batch: redeem, the Relay
  approval up to the cap, the Relay call and the paymaster approval (`policy/refill.test.ts`); no rule was added.
- **Where it runs.** In the owner's `WalletLedger` Durable Object, on its alarm, never in a request: a bridge with
  Relay's fill takes 20 to 30 seconds, more than `waitUntil` allows after a response. The alarm builds the owner's
  signer and rails from its own store (`owner-deps.ts`).
- **One at a time.** A run claims the owner's single flight in the ledger before anything is quoted. A claim while one
  is in flight returns that one. A refill holds the flight while it is being sent, sent, unknown, or deposited with
  Relay's arrival pending, for at most ten minutes after its last change. A run asks Relay once more about a pending
  arrival and frees the flight when it landed. A refill whose run was lost turns unknown, never resent.
- **On the books.** Each refill is an operation (`float:<ms>:<n>`, kind `bridge`, rail `relay`, "Moved $2.00 to Tempo
  for paid inference"), with its UserOperation, transaction and Relay request. It is never reserved, so the ledger's
  per-call, hourly and weekly windows do not count it. The Tempo payments it funds are counted when they are paid, and
  the on-chain allowance bounds the refill itself. A revoked wallet or an expired grant refills nothing.
- **Failures.** A refill that failed, or a chain that did not answer, is recorded and run again after 1 and then 5
  minutes. After that, refills pause for an hour. Nothing is retried that may have moved money.
- **Triggers.**
  1. The owner confirms a Base allowance on mainnet: the seed.
  2. An MPP payment leaves the float under $1: a check 30 seconds later, once the service has redeemed it.
  3. A charge is refused for want of USDC.e while a refill is in flight or can start now. The alarm is set at once,
     and `pay_challenge` answers `insufficient_funds` with "Refilling from your Base allowance; try again in about a
     minute." and `retryAfterSeconds: 60`. Otherwise it answers as before, naming the address to fund.
- **Testnets** never refill: MPP payees take mainnet payments only.

**`wallet_status`** keeps `stablecoinUsd` as the owner and agent total, and adds `float` (`held`, `low`, `target`,
`refilling`, `automatic`). It asks the owner to fund Tempo by hand only when the allowance cannot refill it, and says
why: none signed, expired, used up this period. When the owner's Base USDC is what is missing, it asks for that.

## Consequences

- The owner's hourly allowance also carries the refills: a $3 refill leaves $17 of a $20 hour for Base spends.
- The first paid call after the float ran dry fails once with the refill message; goblin's next call pays.
- A second Durable Object behavior (the alarm) is covered by node tests against a fake host, not workerd.
- The float is a second place the owner's money sits. It is bounded by the target, and it stays the agent's own
  USDC.e: revoking the wallet stops new refills, not what is already on Tempo.

## Rejected

- **Bridging inside `pay_challenge`.** It would make an inference call wait 20 to 30 seconds and pay Relay per call.
- **`waitUntil` in the Worker.** Its 30 seconds after the response do not cover a bridge and Relay's fill.
- **Counting refills against the wallet's spend windows.** They move the owner's money to the agent's own address;
  the payments made from it are the spends, and counting both would charge each dollar twice.
