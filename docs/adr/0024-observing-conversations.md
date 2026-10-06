# Observing conversations

Accepted 2026-10-06 with the owner; amended the same day (see Amendments).

**Pi stays the record; goblin adds a run ledger and telemetry beside it.** Pi already keeps each message, tool call,
tool result and, on every model response, the model, token usage, stop reason and error. It does not keep how long a
model attempt or tool call took, attempts that failed and were retried, recovery after eviction, model calls made
outside a turn (thread names, memory summaries, skill drafts, an app's `llm` power), or whether a Telegram reply went
out. goblin records those as `RunEvent`s:
- one instrumentation module emits them from Pi's extension hooks (`beforeRequest`/`afterResponse`,
  `beforeTool`/`afterTool`, `beforeCompact`), the submission sites, the channel, the MCP host and the Agents SDK
  diagnostics channels;
- each event goes to a ledger in the agent's Durable Object (`app_run_events`), to one structured Workers Log line,
  and to Cloudflare trace spans;
- events and attributes use the OpenTelemetry GenAI semantic conventions (`chat {model}`, `execute_tool {tool}`,
  `gen_ai.usage.input_tokens`, …) plus `goblin.*` ids, so any OpenTelemetry tool can read them;
- the ledger keeps 30 days. An attempt that started and never ended is marked interrupted.

**No conversation content leaves the Durable Object as telemetry.** Ledger rows, log lines and spans carry ids,
counts, sizes, timings, outcomes and error text, never message, prompt or tool payloads. Error text from remote
servers is kept as data. Content is read from Pi through the inspection tools below.

**Inspection is a separate, read-only MCP resource.** `/mcp/inspect` is its own OAuth protected resource: its own
audience, metadata and consent, and the scope `goblin:inspect`. It reaches only the signed-in user's own agent and
serves only read tools: conversations, one conversation's entries (full content, paged and bounded), one turn's
timeline, and recent problems. Reads never call a model. `/mcp` and `ask_agent` are unchanged, so a client that only
talks to the agent never sees inspection. We use a separate resource instead of `insufficient_scope` step-up on
`/mcp` because MCP clients, Claude Code included, do not yet step up reliably; they do request the scope a resource's
first challenge names.

**The agent can diagnose itself.** A read-only `diagnose` tool gives the resident agent its own recent problems and
one turn's timeline, so the owner can ask "why did that fail?" in any channel. It grants nothing.

**A terminal client, not a second API.** The `goblin` CLI is an MCP client of `/mcp/inspect`. Its commands come
from the tools' own schemas, and it joins Workers Logs using the developer's own Cloudflare token on their machine. The Worker never holds a Cloudflare API token.

Consequences:
- Debugging a turn is: recent problems, then the turn's timeline, then the conversation, then the logs by the same
  ids.
- Benchmarks reuse the same events: the instrumentation is exported for the benchmark's own agent with an in-memory
  sink.
- The ledger and log lines cost a few writes per model attempt and tool call; Cloudflare logs and traces keep seven
  days.
- Telegram group chats need their own design: today mygram accepts only the owner's private chat.

## Amendments

- **2026-10-06: operator access withdrawn.** The first cut let stage-allowlisted operators read any user's agent
  through `/mcp/operator`, each read recorded on the operator's side. It was removed before anyone used it
  (`GOBLIN_OPERATORS` stayed empty, so `app_operator_reads` never held a row; the table stays dormant). "A user only
  ever reaches their own agent" holds again without exception. An admin capability needs its own design first.
