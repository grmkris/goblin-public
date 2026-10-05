# ADR 0012: Confirmed routines and isolated run threads

Status: scheduled execution implemented and locally verified; deployed acceptance pending.

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
visible and recovery retries only confirmed revisions. Application migrations …210/…211 are additive and leave
Pi/Agents tables untouched. Shared submission origins and sealed interaction receipts support routine execution
and subsequent Members extensions. Event proposals may be stored; Events activation remains the next slice.

Five-field numeric cron uses one Worker-compatible parser and IANA `Intl` projection. It supports lists, ranges and
steps; unsupported macros and seconds fail visibly. Daily slots must be at least 15 minutes apart, including the
midnight boundary. Spring gaps skip and autumn repeats use the earlier instant. One-off times require an explicit
offset, are stored as UTC instants and must resolve within two years. UTC is the account default; browser timezone is
a suggestion, not an implicit account change.

## Execution contract

Agents SDK dated schedules contain IDs, revision and the firing
instant (dated idempotency ignores the date itself). A short application claim owns the stable operation ID before
model work. Pi background tasks own a fresh empty conversation; routine threads copy no main capability rows and
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

Planned Events bindings use ADR 0011's shared dispatcher, consumer revisions, acknowledgments and ref-counted leases. Event
payloads are untrusted data and never instructions or permission. Controls create health/reconciliation work only.

## Evidence

Unit tests cover explicit offsets, invalid zones/dates, minimum cron spacing, both DST transitions and strict write
CSRF. Native workerd tests cover actual application migrations, replay receipts, revision fences and reconstructed
definition services, isolated native Pi manual runs, passive report dedupe, committed usage, authority skips,
correlated owner questions, answer replay/expiry, actual reminder alarms, collapsed cron slots, main Stop during
execution, running limits, one pending burst and archive fences. They do not establish real Telegram delivery,
provider billing or deployed acceptance. Separate workerd processes also recover a retained question in the same Pi session. Native compaction charges 45
fixture tokens once; replay on the next UTC day charges zero. The injected model overshoots a 1000-token cap by
10 tokens from its single in-flight response. Injected Telegram retries reuse identical bytes and distinguish the
remote receipt from the passive main write. These fixture values do not measure a real provider or Telegram host.

Related: [ADR 0010](0010-per-conversation-capabilities-and-thread-notes.md), [ADR 0011](0011-mcp-events.md).
