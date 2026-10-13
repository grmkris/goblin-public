# ADR 0012: Confirmed routines and isolated run threads

Status: scheduled and Event execution implemented; native workerd verified. Phase 1 and the Event checkpoint are deployed on dev; the recurring-wake follow-up and real producer acceptance remain pending.
Amended by ADR 0040: a routine run is bounded by its Topic's setup as well as its own allowed tools.
Amended by ADR 0041: a routine tells the owner, hands over to Goblin or a Persona, or both.
Amended 2026-10-12 (with the owner): a routine that only tells is on the free plan; a hand-over is Pro. See the end.
Amended 2026-10-13 by ADR 0054: there is no free plan, so every routine, its reminders and its Telegram copies need Pro.

## Decision

Routines are versioned definitions in application SQLite. The `routine` Pi tool proposes, lists or pauses; it has no
confirm operation. An authenticated owner reviews and confirms the exact revision through the same-owner API, with
an exact configured Origin and CSRF header. Editing suspends future activation and clears confirmation. Durable
operation receipts retain the first result and reject changed requests using the same ID. The API reads current
definition state after reconciliation, so a confirmation displays `active` once its schedule is armed.

Definitions carry a bounded instruction, once/cron/Event trigger, IANA timezone, exact MCP tool pairs, per-run/day
token limits, absolute runtime limit and explicit Telegram notification policy. The approved caps are 20 active,
two executing, one live or waiting run per routine, a 15-minute cron minimum, one event run/minute and one catch-up.
Account entitlements gate the feature. No action renews resident authority in the background.

Confirmation first persists provenance and `activating`, then reconciles a dated schedule. A failed arm remains
visible and recovery retries only confirmed revisions. Application migrations …210/…211/…212 are additive and leave
Pi/Agents tables untouched. Shared submission origins and sealed interaction receipts support routine execution. Event confirmation grants only the exact server/name/canonical-arguments selector after descriptor-schema validation at subscription.

Five-field numeric cron uses one Worker-compatible parser and IANA `Intl` projection. It supports lists, ranges and
steps; unsupported macros and seconds fail visibly. Daily slots must be at least 15 minutes apart, including the
midnight boundary. Spring gaps skip and autumn repeats use the earlier instant. One-off times require an explicit
offset, are stored as UTC instants and must resolve within two years. UTC is the account default; browser timezone is
a suggestion, not an implicit account change.

## Execution contract

Agents SDK dated schedules contain IDs, revision and the firing
instant (dated idempotency ignores the date itself). A short application claim owns the stable operation ID before
model work. Reconciliation retains only future wakes; the executing scheduler row cannot suppress its successor. Pi background tasks own a fresh empty conversation; routine threads copy no main capability rows and
have no ordinary main-start note. The confirmed tool ceiling narrows `Capabilities.scope`, intersecting current
grants and resident authority at action time. Routine runs omit management, main memory and learner extensions.

Settlement writes one passive `app.routine` entry to main with `routine-report:<runId>` using `Conversation.submit`,
never appending vendor entries. Confirmed Telegram reports reuse frozen bytes and stable operation IDs, and record
external receipts separately from Pi acceptance. Waiting questions correlate to the same run and expire after a day.
Committed `pi.usage` counters, including compaction, project to cumulative app watermarks and stable weighted UTC-day
receipts. Every model dispatch passes a dedicated per-run provider's authority/budget resolver; hooks alone cannot
block model calls because Pi swallows hook exceptions. MCP tool dispatch repeats the check after SDK token refresh.
Token caps cannot stop a response already in flight or make provider accounting exact. Pause blocks
new admission while admitted snapshots may settle; archive cancels only owned schedules/work and retains history.

Events bindings use ADR 0011's shared dispatcher, consumer revisions, acknowledgments and reference-counted leases.
The exact owner-reviewed selector is subscribed through the originating authorized connection. Occurrence IDs use
lossless escaping in `routine:<id>:<eventId>`; existing run receipts dedupe replay across revision changes, including
after ingress receipt retention expires. Metadata is scrubbed, bounded to 1600 characters, encrypted with the run
operation/revision as associated data, then labelled as untrusted data in the fresh run input. The run provider and
MCP scope still check authority at action time; payloads grant nothing.

The agent admits at most one event run per minute. A busy/spacing conflict persists one sealed pending firing and
acknowledges its consumer in one short app transaction, after arming recovery. Replays never replace it again. Gap
controls show health and let shared Events poll the exact selector. Verification and termination create no model
turn; termination pauses the definition and requires fresh owner confirmation. Pause advances Event revisions,
edit clears confirmation, and archive retires only that consumer. Other consumers retain a shared remote lease.

## Evidence

Unit tests cover explicit offsets, invalid zones/dates, minimum cron spacing, both DST transitions and strict write
CSRF. Native workerd tests cover actual application migrations, replay receipts, revision fences and reconstructed
definition services, isolated native Pi manual runs, passive report dedupe, committed usage, authority skips,
correlated owner questions, answer replay/expiry, actual reminder alarms, collapsed cron slots, main Stop during
execution, running limits, one pending burst and archive fences. They do not establish real Telegram delivery,
provider billing or deployed acceptance. Separate workerd processes also recover a retained question in the same Pi session. Native compaction charges 45
fixture tokens once; replay on the next UTC day charges zero. The injected model overshoots a 1000-token cap by
10 tokens from its single in-flight response. Injected Telegram retries reuse identical bytes and distinguish the
remote receipt from the passive main write. Signed Event fixtures also prove shared leases, bad signatures, replay,
metadata sealing/scrubbing/labelling, per-agent spacing, pending coalescing/drain, descriptor argument rejection,
gap/poll recovery, termination/reconfirmation and edit retirement. Labelling is structural evidence, not a model
injection-resistance claim. These fixture values do not measure a real provider or Telegram host.

A real native wake regression fails when the callback counts its own firing row and passes when only future jobs
participate in earliest-wake selection. LOCAL throwaway-account acceptance through CLIProxy verifies one reminder
and passive note, retained cron firing/rearm across a local process restart, revoked-authority skip without usage or
renewal, the twenty-active/two-running caps, Event editor validation/review and run/day token blocking. CLIProxy reported 1526 committed weighted tokens for the first response under a one-token test cap (1525 overshoot); the next run added no usage. This meter is not an exact provider billing measurement. This proves the local source with its wake fix, not remote
eviction, Railway billing or live Event producers.

## Amended 2026-10-12: Tell me on the free plan, hand-over on Pro

Kris connected mysi on a free account and setting up its events ended in a 402 that read "Subscribe to Pro to use your
personal agent" (prod `POST /api/routines`). He decided that free accounts get **Tell me** and only a hand-over needs
Pro:

- The plan gates two features where it gated one (`billing/plans.ts`, `billing/gates.ts`): `routines`, which the free
  plan now has, and `handOver`, which it does not. A routine that only tells makes no model call: its event notices,
  reminders and their Telegram copies work end to end on the free plan.
- Proposing or editing a routine, and confirming (or confirming again) one, check what its definition needs: `handOver`
  when it hands its work to Goblin or a Persona, else `routines`. Pausing and archiving stay the owner's on any plan,
  so a downgraded account can still stop a hand-over.
- Run admission (`admissionSkip`) and the run provider (`requireRoutine`) check `handOver`: a downgraded account's
  hand-over firing is recorded skipped (`SubscriptionRequired`) and no model call is made.
- The refusal names the feature: `SubscriptionRequired` carries `feature: 'hand_over'`, and its copy says handing an
  event or a schedule to goblin or a Persona is part of Pro, with "or have it only tell you" as the way on. The web
  shows the same words (`failureCopy`), and its picker and editor show hand-overs on the free plan as Pro-only with a
  link to `/subscribe?return=<page>`.

Evidence: the entitlement and error-envelope unit tests cover the split and the copy. Free-account Tell me end to end
(subscription, notice, Telegram) is to be accepted on dev.

Related: [ADR 0010](0010-per-conversation-capabilities-and-thread-notes.md), [ADR 0011](0011-mcp-events.md).
