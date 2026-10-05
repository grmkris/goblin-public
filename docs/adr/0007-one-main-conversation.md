# One main conversation that never ends, with side threads and subagents

Accepted 2026-10-04 with the owner. Amended by ADR 0010: main learns the name of a thread started with "+".

**Each agent has one main conversation.** Main is Pi's root session. Everyone who reaches the agent talks there:
- the owner's browser;
- inbound MCP clients, which no longer get hidden sessions of their own;
- later, Telegram.

Each message from anyone but the owner's browser starts with an author tag block, `[from <author>]`, so the model and
the web both know who wrote it. Inviting other people to the agent comes later.

**Side threads are for the occasional detour.** A thread is either a Pi fork of main at any settled message ("Branch
from here"), which sees main up to there, or an empty conversation. Threads do not branch further. Nothing in a thread
reaches main unless the owner asks the thread to share: `share_to_main` writes a note into main. The model there sees
the note and does not answer it, because a Pi write starts no run.

Pi cannot delete a conversation, so archiving only hides a thread. After the first exchange the memory model names the
thread, and the owner can rename it. `app_conversations` registers every conversation a request may open. A session id
reaches Pi only if it is registered, so nobody can open a conversation by guessing its number.

**Subagents work in the background and report back.** Main and threads can start subagents with one `subagent` tool,
after Pi Durable's background subagent example:
- Each subagent is a conversation owned by a background anchor task of its spawner, so the spawner's Stop does not
  reach it.
- It runs the owner's picked model with the same grants. It gets no subagents of its own and no `ask_user`.
- Its answer comes back to the spawner as an input labelled `[from subagent <name>]`, which the spawner answers.
- One level only; at most three work at once.

**Main remembers through an OptChat summary tree.** We adopt VictorTaelin's OptChat design for main's memory:
- Every message since activation is summarized in order into lines of about 512 bytes by the cheapest offered model
  (`PURRABLE_MEMORY_MODEL`), whose tokens count toward the owner's budget.
- Adjacent lines merge in pairs into a binary tree, and the tree is folded into a 48 KB view.

We deviate from OptChat in three ways:
- **Pi keeps the conversation continuous.** The view enters main as an `app.memory` entry whose head is main's newest
  input, exactly how Pi places a compaction. The model reads the view and then the newest exchange verbatim.
- **Nothing waits for the summarizer.** A message that is not summarized yet is simply still shown in full; OptChat
  instead holds each turn until every view line is a summary.
- **Only the merges the view needs are built.**

`zoom` opens a line down to a message, from main and from the threads branched from it, which are bounded at their fork.
Memory starts fresh at activation: older history stays in Pi and in the web's history pages, outside the model's
context once the first view lands. Threads and subagents keep Pi's own compaction.

Consequences:
- The web cannot read the whole conversation from Pi's snapshot once a view or a compaction starts it later. It reads
  earlier entries through a history route and hides those marker entries.
- A summary of the agent's tool work keeps little of the output. The guide tells the model to say in its reply what
  it learned.
- The memory costs summarizer calls on every message that does not fit a line by itself.
