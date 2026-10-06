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
- Dev uses `dev.goblin.surf`, email OTP from `hello@goblin.surf`, and a private owner bootstrap followed by closed
  sign-up. Its owner receives an explicit dev-only Pro override of 2M weighted tokens per UTC day. The dedicated
  provider key separately caps aggregate spending at $10 per 30 days and restricts offered models. Reopening signup
  needs a global account-admission policy and provider capacity review. Production payment acceptance and merchant
  onboarding remain separate work; dev's operator override grants nothing on prod.
