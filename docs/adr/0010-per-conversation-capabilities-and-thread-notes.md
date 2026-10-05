# Per-conversation capabilities, and main learns the names of threads started with "+"

Accepted 2026-10-05 with the owner. Amends ADR 0007 (what reaches main from a thread) and ADR 0008 (skills switched on
for a server can be narrowed per conversation). Amended by ADR 0017: a new thread copies the switches of the conversation
it came from, and Reset restores those.

**Main learns the name of a thread the owner starts with "+".** A thread branched from a message of main already
shows under that message. A thread started empty, from the "+" beside Threads, used to leave no trace in main. Now,
once such a thread has a title (the memory model's after its first exchange, or the owner's), main gets one passive
note:
- an `app.thread_started` Pi write naming the thread, `[thread started: "<title>"]`, which main's model sees and which
  starts no run;
- request id `thread-started:<id>`, and `app_conversations.main_note` (`owed`, then `written`), so it is written once;
- main's transcript shows it as a row for the thread, with the thread's current name and replies.

Nothing said in the thread goes with it, and a later rename does not rewrite it. Branched threads, subagents and threads
started by anything but the owner's "+" get no note. Main's memory keeps the note as an owner line, like a shared note.

**Each conversation can switch off what the agent may use in it.** The owner's grants (ADR 0003), skills switches
(ADR 0008) and the subagent tool stay agent-wide; a conversation can narrow them, never widen them:
- per connected server, and per granted tool of that server;
- per skills library;
- whether it may start subagents.

A conversation stores only what is switched off (`app_conversation_capabilities`), so a tool granted later is on
everywhere until someone switches it off. Main has switches too; Telegram and connected MCP clients talk in main, so
main's apply to them. A new thread, branched or empty, copies main's switches when it is created, then is independent;
"Reset to main's setup" copies them again. A subagent stores none: it is bounded by the switches of every conversation
above it, read live.

What is switched off is hidden from the model in that conversation: `mcp_list` omits it, the skills section leaves the
library out, and Pi's per-conversation tool filter removes `subagent`. If the model still calls it, nothing runs: the
tool returns a `capability-off` result and the owner gets a "Turn on here" card, which turns it on in that conversation
only. The check runs before the grant check and before any connection is made.

One gate decides: `CapabilityProfiles.scope(session)` in `capabilities/profiles.ts`. Later bounds (a subagent definition's ceiling, a routine's allowlist) narrow the same scope rather than add checks.

Consequences:
- The owner's console calls and an MCP App's own calls are the owner's acts and carry no conversation; they are not
  narrowed. Telegram's own delivery plumbing is not either; the model's `send_message` is.
- A tool switched off mid-run can still be in the model's context from an earlier `mcp_list`; the call itself is
  refused.
- Switching subagents on or off reconfigures the conversation in Pi, which costs one prompt-cache miss.
