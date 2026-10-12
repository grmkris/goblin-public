# ADR 0044: Spending rules for paid tools

(MCP call approvals).

Mercator's `create_job` spends from the owner's wallet (ADR 0043). Ask first (ADR 0028) makes the owner approve every
job, which is right at the start and tiring after a while; "Run when needed" leaves only the wallet's own limit. The
owner wants to say "you may run jobs up to $5 without asking me" and still have a running total.

## Decision

**A spending rule is the owner's limit on a paid tool, per job and per day, in goblin.**
- It exists for a tool whose first-class profile names its spending argument and currency (for Mercator,
  `create_job`'s `approved_total`, in US dollars).
- A paid tool's setting is one of: **Ask first** (the default once the owner applies the recommended set), **Run jobs
  up to $X without asking** with an optional **daily total** of $Y, or **Run when needed**.
- Under a rule, a call runs without asking when its amount is at or under $X and the day's total, with it, stays at or
  under $Y. Otherwise it asks, exactly as Ask first. A call whose amount is missing or is not a plain decimal asks.
- Amounts are read as whole micro-dollars, never as floating point.
- Every paid call goblin sends, approved or not, is recorded against the day before it is sent: the check and the
  record are one transaction, so two calls at once cannot both fit under the total.
- On the approval card the owner can approve and set the rule in one go ("Approve, and run jobs up to $5 without
  asking"). The rule is written after the approved call is sent, so the approval keeps the grant version it was made
  against.
- The wallet's own limit (its ceiling per period, chosen when the owner signs in to the server) is shown beside the
  rule and stays the hard stop. goblin never raises it.

**Who may spend under a rule.** Goblin in a chat, a Persona and a routine the owner confirmed. Agent apps, the
Telegram channel and the skills learner call as background work: a paid tool always refuses them.

## Rejected

- **Only the wallet's limit.** It is set once at sign-in, outside goblin, and counts every client of the wallet; the
  owner wants a limit for this agent that they can change from a card.
- **Per job only.** Many jobs under the limit could still empty the wallet up to its ceiling.
- **A rule on any tool's arguments.** Which argument is money, and in what unit, is goblin's knowledge of a server it
  supports, not something a tool can claim.

## Consequences

- A new pair of tables, `app_mcp_spend_rules` and `app_mcp_spend`, added by their own migration.
- The model's tool list says how a paid tool is limited ("asks above $5 a job or past $20 today").
- Topic and Persona budgets, and the Agentic Wallet's own policies, can narrow this later; they never widen it.
