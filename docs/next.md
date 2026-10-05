# Next: seams, not built

Where planned features attach, plus the remaining cleanup. Each new feature needs its own decision when it is built.

## Routines acceptance

Confirmed reminders, cron and MCP Events now run in fresh Pi conversations, report passively to main and obey
resident authority, current grants and confirmed scope. Settings provides exact revision review, caps and run
history. [ADR 0012](adr/0012-routines.md) records native fixtures and the remaining deployed acceptance. Real
producer Events, Railway provider accounting and Telegram completion need separate receipts; local fixtures do
not establish them.

## Write approvals

Today granted model tools run under current resident authority and the token budget, without approval of each call.
The existing Allow card grants a missing tool for future calls. For tools with side effects, add a separate approval
step: a Pi `beforeTool` hook that holds calls to tools the owner marked "ask first", surfaces them in the chat, and
continues or refuses on the owner's answer. Never treat remote annotations such as `readOnlyHint` as the approval
policy.

## Smaller items

- `app_metadata` is created by the application migrations, but its `AppMetadata` service is used only by the
  integration test worker; remove it or give it a job.
- A production stage: its own D1, credential key and model key; nothing is shared with dev.
- Dev sign-up is closed (since 2026-10-04, with a 5M-token daily budget per user) because every account draws on the
  one $10/30-day model key, and the Alibaba models on a weekly Token Plan bucket shared with Hermes. Reopening it needs
  what is not built: a per-user override (raise one account's limit instead of everyone's; today the budget is per
  agent with one limit for the deployment), a global cap on new accounts per day (sign-up rate limits are per IP), and
  a mail domain of Purrable's own (dev sends from `purrable@mytab.lol`). Passkeys are bound to the host they were made
  on: moving dev to its own domain leaves them unusable there (people sign in with a code and add new ones).
