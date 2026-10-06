# ADR 0018: Subagents nest, steer and close

Accepted 2026-10-05 with the owner. Supersedes ADR 0007's subagent rules (no subagents of their own, one level, at
most three at once). Builds on ADR 0017's tree, Close and `keep_open_at`.

**A subagent can start subagents of its own, at any depth.** It is given the persona, the owner's MCP and budget
extensions and the subagents extension itself (`subagentsExtension(run, (self) => [...])`), still without `ask_user` or
skills. Nothing caps how many work at once or how deep they go: the Worker's budget-capped model key bounds the spend,
Stop and Close reach the whole subtree, and the workspace feed shows a subtree that is still waiting.

**Every message to a subagent goes through a relay** (`goblin.subagent-relay`, `pi/subagent-relay.ts`), a background
task in the spawner's conversation, whoever wrote it:
- deliver: submits the message to the subagent with a request id (`subagent:<relay>`, or the owner's operation id) and
  `whenBusy`;
- drain: once the message is answered, waits until the subagent is done: while it runs, until it is idle; while its own
  relays are live, parked on them (`waiting`, `allSettled`); then again, so a report from its helpers that starts a new
  turn is waited for too;
- report: the subagent's newest answer since the message, once (the roster remembers reported answers), as an input
  labelled `[from subagent <name>]` to the spawner only. The spawner hears the final answer, never "started my
  helpers, waiting".

When several messages to one subagent are on their way, only the last relay to finish reports; the others keep what
the owner wrote for it. A run that was stopped reports nothing.

**A subagent closes when its job is done.** After the relay reports, it closes the subagent (and what is under it)
with `closed_by: 'done'`, unless the owner engaged with it (`keep_open_at`: they wrote to it, branched a thread from it
or pinned it) or another message to it is still on its way. A spawner's message to a subagent closed as done opens it
again, and the tool says so; one to a subagent the owner closed is refused until the owner reopens it.

**The owner can write to a subagent.** A closed subagent refuses, as every closed conversation does (the web offers
Reopen). Otherwise the subagent is pinned open, the owner's model applies, and the message goes through a relay in its
spawner like the spawner's own: it steers the current run when the subagent is busy (`whenBusy: 'steer'`), else starts
a turn. The report quotes what the owner wrote (one line, at most 300 characters), so the spawner knows it was asked.
The owner's operation id is the delivered submission's request id, so their browser waits on it as on any message.

**Owner authority gates background work.** The tool and relay use the Agent's account plan gate. Resident authority
is checked before tool execution, relay delivery and reporting. Subagents use the owner's provider and daily budget.

**Stop and Close cascade, and a job cut short reports nothing.** Stop in a conversation, the tool's `stop`, and the
owner's Close first stop the relays carrying messages to each subagent they reach, then abort the subagents across
background boundaries, top down. Without that, a relay parked on helpers would wake when they were aborted and report
a half-done answer.

Consequences:
- Only main's answers to its own subagents' reports go to Telegram; reports of a message the owner wrote do not.
- The feed's `waiting` follows live relays.
- Reporters (`goblin.subagent-reporter`) still in flight when this deploys have no definition: their answer is not
  reported (once), and a Stop or Close settles them as orphaned.
- The runtime has no `runningSubagents` count any more.
