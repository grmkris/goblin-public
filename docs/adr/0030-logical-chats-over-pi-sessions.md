# ADR 0030: Logical chats over Pi sessions

Accepted 2026-10-08. Builds on ADRs 0007, 0010, 0017, 0018 and 0029.

“Move to thread” needs an identity swap: the browser must keep following Main while its previous conversation becomes
an ordinary thread. Pi cannot move a running turn between conversations. A stable application chat identity lets a
future mover change which Pi session that chat addresses without rewriting Pi's tasks, entries or operation receipts.
This phase introduces the identity layer; it does not implement the mover, Topics or per-primary memory.

## Stored identities

A chat id is the existing `app_conversations.session_id` primary key. Its SQL name stays intact; Drizzle calls the
property `chatId`. Capabilities, exclusions, names, tree parents, close/read marks, `main_note` and routine placement
remain keyed by that same stable chat id, so their existing data does not move. Main keeps chat id `1`, exported as
`PRIMARY_CHAT`; `/c/1` and the browser's existing validators stay unchanged.

An additive migration adds `pi_session` (backfilled from the primary key and uniquely indexed), `epoch` (initially
zero), `role` (`primary` on existing Main rows) and `spawner_session` (backfilled from subagent parents).
`parent_session` describes the chat tree. A helper's `spawner_session` is the immutable Pi session where its anchor
and relays live, even if the parent's chat later rebinds. `app_registry.chat_id` separates App placement from the Pi
session that owns an MCP App's original call. No vendor-owned table is changed.

## Resolution and admission

`ChatDirectory` in `chats/directory.ts`, provided as the Effect `Chats` service, owns the boundary. Runtime-only
`ChatId` and `SessionId` brands distinguish the two identities. `primary()` returns the stable primary chat;
`session(chat)` requires a registered chat; `chatOf(session)` finds only its current owner. Fresh-agent registration
seeds Pi root once and never overwrites a retained binding.

Owner input, inbound MCP and Telegram admit stable operations to `app_chat_operations`, keyed by `(chat_id,
operation_id)`, before submitting them to Pi. The row records the selected Pi session and admission time. A retry
uses the recorded session through `operation`/`admit`, including after a rebind, and waits there. An existing row is
intent, not evidence that Pi accepted it: the caller still submits the same operation, letting Pi deduplicate it and
recover a crash between intent and submission. Rows older than 30 days are pruned opportunistically. This is a bounded
application replay guarantee; Pi acceptance still says nothing about completed external effects.

`withChat` is an in-isolate, per-chat admission lock. It covers Pi admission only and releases before model execution
or waiting for an answer. SQLite transactions contain only local metadata work. `rebind(chat, { from, epoch }, to,
now)` performs a compare-and-set, increments the epoch and refuses a session owned by another chat. A stale mover gets
`Conflict`. Rebinding notifies listeners: the SSE adapter closes that chat's connected streams and the registry emits a workspace
change, so clients reconnect with a fresh snapshot. There is no production rebind caller yet; a future mover must
coordinate in-flight work and admission rather than treat the fence as a way to move a Pi task.

## Callers

Browser routes, snapshots, history, queue operations, model selection and the workspace feed use chat ids. SSE resolves
at connection; Pi task-graph activity is projected back through `chatOf`. `ConversationView.primary` and
`WorkspaceSnapshot.primary` are optional additions for compatible readers.

The owner, inbound and Telegram paths use the operation ledger for input admission and readback. Subagent-report
Telegram tracking records its operation binding; eligibility tests the spawner Pi session's current chat ownership.
Routine reports, thread-start notes and share-backs resolve the current target chat before their passive Pi write.
Their stable Pi request ids deduplicate writes in that session and start no model run.

Capabilities map the calling Pi session through `chatOf` before reading chat switches; unknown or no-longer-owned
sessions fail closed. Reconfiguration maps chat ids back to current sessions. Composer selection, helper registration,
App placement/close/rehome and approval continuation preserve the same distinction.

Main memory resolves the primary's current session for activation, entry reads and builder work. The Builder document
is read on the generation API's `conversationId`. The existing memory store is still agent-wide; rebinding alone is
not a per-primary memory implementation.

## Identities that remain Pi-owned

| Data | Identity retained |
| --- | --- |
| Pi entries, tasks, submissions, request ids and documents | Pi session and Pi-native ids |
| `app_mcp_approvals` | Pi session, source call and task |
| MCP App call arguments/results | Original Pi session and call id |
| `app_skill_activations`, `app_run_events` | Pi session |
| `fork_entry`, `spawner_session` | Original Pi entry or spawner session |
| `app_memory_log.entry_id` | Global Pi entry id |

Inspection resolves a chat filter to its current Pi session before querying the run ledger. Individual timelines and
submission readback retain the event's recorded Pi session. Historical events are not rewritten when a chat rebinds.

## Consequences and verification

The web keeps stable chat ids; this phase changes no user-facing workflow. A later mover can rebind application
identity without modifying vendor state, but must define swaps, retained old-session work and memory transitions.
Topics and per-primary memory remain future work.

`check:chat-ids` parses runtime source with Oxc and bans root constants and session-less harness submission/session
calls outside the chat layer. Unit tests cover bidirectional lookup, retry bindings, retention, ownership, stale fences
and independent-chat locks. The local workerd permuted-primary profile rebinds chat `1` to a fresh non-root session in
test subclasses before service composition, then runs the owner, helper, routine, Telegram, memory and related native
cases. Explicit owner and inbound proofs check the new session and an empty root transcript. The separate raw Pi
lifecycle fixture intentionally still tests root defaults.

These are unit and local workerd proofs. They establish no deployed-stage, live-provider, Telegram-service or remote
eviction acceptance. The root full check includes both ordinary integrations and the permuted profile.
