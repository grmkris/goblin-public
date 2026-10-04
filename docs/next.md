# Next: seams, not built

Where planned features attach. None of this exists yet; each needs its own decision when it is built.

## Routines

Scheduled work for the agent, for example "every morning, summarize today's plan".

- Store routines in an `app_routines` table (id, cron, prompt, enabled) and schedule them with the Agents SDK
  `this.schedule(cron, 'runRoutine', { id })` from `PersonalAgent`.
- `runRoutine` submits to Pi with operation ID `routine:${id}:${firedAt}`, so a retried alarm cannot run a routine
  twice. Decide per routine whether it uses the main thread or its own session.
- Routines run under resident authority. If it has lapsed, record the skip and show it, do not fail silently.

## Write approvals

Today every granted tool runs when the model calls it. For tools with side effects, add an approval step: a Pi
`beforeTool` hook that holds calls to tools the owner marked "ask first", surfaces them in the chat, and continues or
refuses on the owner's answer. Never treat remote annotations such as `readOnlyHint` as the approval policy.

## Smaller items

- `app_metadata` and the `AppMetadata` service are used only by the integration test worker; remove them or give
  them a job.
- A production stage: its own D1, credential key and model key; nothing is shared with dev.
- Dev sign-up is closed (since 2026-10-04, with a 5M-token daily budget per user) because every account draws on the
  one $10/30-day model key, and the Alibaba models on a weekly Token Plan bucket shared with Hermes. Reopening it needs
  what is not built: a per-user override (raise one account's limit instead of everyone's), a global cap on new
  accounts per day, and a mail domain of Purrable's own (dev sends from `purrable@mytab.lol`). Passkeys are bound to
  the host they were made on: moving dev to its own domain leaves them unusable there (people sign in with a code and
  add new ones).
