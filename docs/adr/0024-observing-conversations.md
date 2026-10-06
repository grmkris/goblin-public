# Observing conversations

Accepted 2026-10-06 with the owner; amended the same day (see Amendments).

**Pi stays the record; goblin adds a run ledger and telemetry beside it.** Pi already keeps each message, tool call,
tool result and, on every model response, the model, token usage, stop reason and error. It does not keep how long a
model attempt or tool call took, attempts that failed and were retried, recovery after eviction, model calls made
outside a turn (thread names, memory summaries, skill drafts, an app's `llm` power), or whether a Telegram reply went
out. goblin records those as `RunEvent`s:
- they come from Pi's commit listener (turns, model attempts, tool calls and compaction, for every conversation),
  the agent's restart (recovery), the cheap-model wrapper (model calls outside a turn), the MCP host's step log and
  the Telegram channel;
- each event goes to a ledger in the agent's Durable Object (`app_run_events`), to one structured Workers Log line,
  and to Cloudflare trace spans;
- events and attributes use the OpenTelemetry GenAI semantic conventions (`chat {model}`, `execute_tool {tool}`,
  `gen_ai.usage.input_tokens`, …) plus `goblin.*` ids, so any OpenTelemetry tool can read them;
- the ledger keeps 30 days. An attempt that started and never ended is marked interrupted.

**No conversation content leaves the Durable Object as telemetry.** Ledger rows, log lines and spans carry ids,
counts, sizes, timings, outcomes and error text, never message, prompt or tool payloads. Error text from remote
servers is kept as data. Content is read from Pi through the inspection tools below.

**Inspection is a read-only scope on `/mcp`.** The same `/mcp` that offers `ask_agent` gives a client the owner let
inspect, with the scope `goblin:inspect`, read tools: conversations, one conversation's entries (full content, paged
and bounded), recent turns, one turn's timeline, and recent problems. They reach only the consenting user's own agent
and never call a model, so they need no plan; asking does. `/mcp` advertises the scope and its first challenge names
it, so a new connection asks for it and the consent page says what it adds. A token's scopes count only while the
owner's standing consent still grants them: narrowing or revoking consent ends inspection at once.

**The agent can diagnose itself.** A read-only `diagnose` tool gives the resident agent its own recent problems and
one turn's timeline, so the owner can ask "why did that fail?" in any channel. It grants nothing.

**A terminal client, not a second API.** The `goblin` CLI is an MCP client of `/mcp` that asks for `goblin:inspect`.
Its commands come from the tools' own schemas, and it joins Workers Logs using the developer's own Cloudflare token on
their machine. The Worker never holds a Cloudflare API token.

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
- **2026-10-06: one MCP endpoint.** The first cut served inspection from `/mcp/inspect`, a protected resource of its
  own, because MCP clients do not yet step up on `insufficient_scope`. That made goblin two MCP servers (three with
  the operator's) where an MCP client should plug into one. Inspection became a scope on `/mcp`: clients already
  request the scopes a resource's first challenge names, which is all it needs. Clients connected before keep
  `ask_agent` and `get_recent_messages` and get the inspection tools after reconnecting once, which asks the owner
  again; a D1 migration (`0009_mcp_inspection_scope`) lets clients registered earlier ask for the scope, and retires
  the old resources. Asking the agent, not reading it, needs a plan.
- **2026-10-06: inspection is opt-in on the consent page.** A client that asks for `goblin:inspect` gets a separate
  switch for it, off by default; Allow without it grants the other scopes only. Reading every conversation is more
  than most clients need, so the owner chooses it rather than accepting it with the rest.
- **2026-10-06: event sources corrected.** The first text said events came from Pi's extension hooks and the Agents
  SDK diagnostics channels; they come from Pi's commit listener and the emitters listed above.
