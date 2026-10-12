# 0049: Prepaid servers topped up from the Goblin Wallet

Accepted 2026-10-12 with the owner, for the first-run onboarding. The plan is
(URL requests), 0043 (first-class servers), 0044 (spending rules), 0045 (Goblin Wallet) and 0047 (the `inference`
caller).

## Context

Mercator runs paid jobs from its own balance: USDC.e in the owner's Mercator wallet on Tempo. Its
`get_connection_status` reports that wallet's address (`account.walletAddress`) and its balance
(`readiness.tokens[].balance`; "unavailable" when Tempo could not be read, which is not zero). Until now the owner
funded it by hand on mercator.sh, so a job it was short for failed in the middle of a chat. The owner already keeps a
Goblin Wallet that goblin pays from within limits. They decided that goblin moves money from it to Mercator by itself,
transparently, under a rule ($5 a top-up and $20 a day without asking), and that any other first-class server with its
own prepaid balance gets the same.

## Decision

**A profile can declare a prepaid balance.** `prepaid: { chain, token, perTopUp, daily }` on the first-class profile
(dollars as decimal strings): the chain and token the balance is in and the default rule. Mercator's is
`{ tempo, USDC.e, 5, 20 }`. The server's own status says where it is funded: goblin decodes `depositTo { address,
chain, token }` into its `WalletStatus` and keeps the balance in `tokens`. An address that is not a real EVM address,
or the zero address, reads as none.

**goblin funds a job before it goes out (`ensureFunded`, `mcp/top-up.ts`).** Right before a prepaid server's paid tool
is sent (Mercator's `create_job`, by its `approved_total`), from the approved dispatch or the model's own call:
- goblin reads the server's status as its own background work;
- when the balance is short it tops up by the shortfall rounded up to a whole dollar, and at least $2;
- a balance that cannot be read, a missing address, or one in another chain or token moves nothing, and the job finds
  out for itself.

**The rule lives in the spending rules (ADR 0044) under the tool key `topup`.** It is per prepaid connection, and the
profile's default applies until the owner changes it (`GET`/`PUT /api/mcp/:id/top-up`).
- Within the rule, the top-up is recorded against the day in the same transaction that checks the day's total
  (`app_mcp_spend`), with where it goes (`destination`: `<chain>:<token>:<address>`), under the operation id
  `topup:<connection>:<n>`. Then it is sent.
- Above the rule, nothing moves. The job is not sent, and its turn reads why and what the owner can do: raise the
  rule on the server's card, or add funds themselves.

**A dedicated MCP caller, `funding`, sends it, as `inference` pays model calls (ADR 0047).**
- The manager lets `funding` reach only the wallet profile's funding tool (the Goblin Wallet's `transfer`).
- The agent's own check (`heldCalls`) lets a funding call out only as a recorded top-up: its `operation_id` names the
  record, and the call moves exactly the recorded amount, in its chain and token, to its address. That record is the
  owner's decision for the wallet's `transfer`, which asks first for every other caller.
- The address comes only from the prepaid server's own status, decoded by goblin, never from model text.
- The grant still applies: without the wallet's `transfer` allowed, a top-up is refused.

**The wallet's first payment to a new recipient asks the owner.** goblin's funding call declares URL elicitation
(ADR 0042, F5). The wallet's request is kept under the job's call, so the job's card follows to it. The job's approval
is spent, and the owner finishes the request on the wallet's page. Done sends the transfer again as `funding` under
the same record. The turn then hears that the top-up went out and that the job did not run yet; the model creates it
again, and it is funded.

**The owner sees every top-up.** Each one that goes out writes an Activity notification and a line in the job's chat,
"Moved $5.00 to Mercator from your Goblin Wallet" (a notice, `routines/notices.ts`). A content-free `top_up` flow step
records how it ended. Mercator's card in Connections shows its balance and the rule, "goblin tops it up from your
Goblin Wallet: up to $5 a top-up and $20 a day without asking", with Change (`PrepaidLine`, which Start's Mercator step
reuses).

## Consequences

- No money moves for a job that would be refused. The approved dispatch checks resident authority, the conversation,
  the tool's scope, the grant version and the endpoint before it funds the job.
- A top-up that is recorded counts toward the day even when the wallet then refuses it or it cannot be confirmed: the
  record is conservative, never short.
- The wallet keys each transfer by its operation id. A transfer that is retried never sends twice, and an uncertain one
  is reported as "may have gone through", never repeated.
- The first top-up to Mercator's address asks the owner twice: once for the wallet's new recipient, then for the job
  again when it is not under a spending rule. Later top-ups to the same address run within the rule without asking.
- Money a top-up moved stays in the owner's Mercator balance even if the job then fails.

## Rejected

- **Holding the top-up as an ask-first approval card.** The approvals table admits only the model, an App and the
  owner as callers, and a transfer's card cannot show under the job's call. Above the rule, the job says what to
  approve instead.
- **Topping up when a job is held, before the owner approves it.** That would move money for a job they may refuse.
- **Topping up from model text** (an address or an amount the model gives): the model reaches neither the caller nor the
  record.
