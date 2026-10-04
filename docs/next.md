# Next: seams, not built

Where planned features attach. None of this exists yet; each needs its own decision when it is built.

## Routines

Scheduled work for the agent, for example "every morning, summarize today's plan".

- Store routines in an `app_routines` table (id, cron, prompt, enabled) and schedule them with the Agents SDK
  `this.schedule(cron, 'runRoutine', { id })` from `PersonalAgent`.
- `runRoutine` submits to Pi with operation ID `routine:${id}:${firedAt}`, so a retried alarm cannot run a routine
  twice. Decide per routine whether it uses the main thread or its own session.
- Routines run under resident authority. If it has lapsed, record the skip and show it, do not fail silently.

## Telegram

- Use the Agents SDK channel support (`agents/channels/telegram`) and route messages into the main thread, so the
  browser and Telegram share one conversation.
- Map Telegram's update or dispatch ID to the Pi operation ID for idempotent delivery.
- Link accounts, not configuration: Settings shows a one-time code, the user sends `/start <code>` to the bot, and the
  bot stores that Telegram user ID against the user. Messages from unlinked Telegram users are ignored.

## Write approvals

Today every granted tool runs when the model calls it. For tools with side effects, add an approval step: a Pi
`beforeTool` hook that holds calls to tools the owner marked "ask first", surfaces them in the chat, and continues or
refuses on the owner's answer. Never treat remote annotations such as `readOnlyHint` as the approval policy.

## Smaller items

- `app_metadata` and the `AppMetadata` service are used only by the integration test worker; remove them or give
  them a job.
- A production stage: its own D1, credential key and model key; nothing is shared with dev.
- Before sign-up can be `open` anywhere: account deletion (ADR 0004), and a domain of Purrable's own to send mail
  from. Budgets and email verification exist; a per-user override (raise one account's limit) does not.
