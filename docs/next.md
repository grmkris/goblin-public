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
- A production stage is live at `https://goblin.surf`: its own D1, credential key, files bucket and capped model key; nothing is shared with dev. The first public release is invite-only and owner OTP/bootstrap remains an operator step.
- Dev is live at `https://dev.goblin.surf`: its fresh auth D1 and PersonalAgent namespace were verified empty before
  bootstrap, the owner signed in with delivered OTP from `hello@goblin.surf` (SPF, DKIM and DMARC passed), and signup
  is closed after bootstrap. The owner has an explicit dev-only Pro override of its daily allowance (in Credits since ADR 0026). The
  dedicated provider key separately caps aggregate spending at $10 per 30 days and restricts offered models. Live
  acceptance passed health, closed-signup refusal, OTP browser login, desktop/mobile layout, OAuth/MCP consent, model
  turns, thread sharing, subagents, memory and client revocation. Reopening signup needs a global account-admission
  policy and provider capacity review. Production payment acceptance and merchant onboarding remain separate work;
  dev's operator override grants nothing on prod.
  Acceptance was recorded on 2026-10-06; the previous dev resources were retired afterwards. Suggested outbound MCP
  connections remain disconnected and ungranted, so live acceptance proves inbound MCP and models; outbound calls
  await fresh owner connections and grants.
