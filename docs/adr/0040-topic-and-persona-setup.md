# ADR 0040: Topic setup and Persona setup

Accepted 2026-10-10 with the owner (research handoff `evidence/handoffs/topic-persona-capabilities-20261010.md`,
then a design interview). Supersedes ADR 0010's per-conversation switches. Amends ADRs 0008 (skills), 0012
(routines), 0017 (a thread copies its parent's switches), 0021 (agent apps), 0032 (Topics) and 0033 (Personas).

A Topic is where the owner keeps one kind of work, so it is where they say what the agent works with there. Until
now each conversation could only switch things off, a thread copied its parent's switches when it was created, and a
Persona could narrow what the chat allowed but never bring anything of its own. The owner wants one knob, the Topic,
and Personas as specialists that bring their own MCP servers and skills to whichever Topic they are asked in.

## Decision

**A Topic has a setup**: its MCP servers, skills, agent apps and whether it may start subagents. Each of the first
three is either `all` (everything the owner has granted or turned on, including what they grant later) or a list.
An MCP server in a list carries all its tools or a list of tools. A skill in a list is a whole library (a skill
server) or one skill, named by its server and skill name; its URI only tells two skills of one name apart, so a new
version of a skill stays selected. Every existing Topic, Personal included, starts as `all`, so nothing changes until
the owner chooses a list. A new Topic is created with a setup (the create dialog's picker, everything by default; or
`topic_create`'s).

**Every chat of a Topic uses its Topic's setup, read live.** Its Conversation, its threads, Telegram and connected MCP
clients in Personal: there are no per-conversation switches any more. ADR 0010's switches, Reset, the copy a new thread
took of its parent's switches and the "Turn on here" card are gone; the rows they stored were deleted when this
landed. A thread moved to another Topic uses that Topic's setup. What is not in the setup is not shown to the model
(`mcp_list`, `<skills>`, `<apps>`, the composer) and does not run.

**A Persona has a setup too: what it adds.** Its MCP servers, skills and apps (each `all` or a list, empty by default)
join its Topic's setup while it answers there: effective = Topic setup ∪ Persona setup. A union needs no tie-break:
a server is the owner's one connection by its id, a skill is one skill by server and name, so the same item from both
is the same thing. A Persona picks only from the owner's own servers, skills and apps; it has no accounts of its own.
The Persona's setup is frozen with its revision when the owner tags it (stored with its fork); the Topic's side is
read live. A Persona's fixed limits stay: it never starts subagents, shares back, asks the owner, organizes, edits
routines or Home. The narrowing exclusions Personas had before are dropped.

**The owner's authority is unchanged and decides last.** Grants, ask-first approvals, a skill server's opt-in,
resident authority and the plan are checked at dispatch exactly as before, after the setup. A setup only chooses
among what the owner allows; it never grants. Because the agent may edit setups (below), a setup is a focus tool, not
a security boundary.

**The agent may change setups, when the owner asks.** `topic_create` takes a setup, `topic_setup` adds to, removes from
or replaces a Topic's, and `persona_create`/`persona_update` take a Persona's. Additions must be things the owner has
granted or turned on. Every change is an organize receipt with Undo (`topic.setup`, `persona.update`). The tools'
descriptions say to change a setup only on the owner's request. Personas and routine runs never have these tools.

**Something outside the setup refuses with a way forward.** When Goblin calls an MCP server, tool or skill the Topic
does not include, nothing runs; the owner is shown "Add it to #Topic" (one click, an owner change with its receipt)
and Goblin waits for them. A Persona or a subagent gets words only and says it could not use it.

**A routine is bounded by its Topic.** A routine run may call only tools its definition allows and its Topic's setup
includes; skills, subagents and apps stay off for routines. When a setup change leaves a routine's allowed tools
outside the Topic, the save names the routines it affects, a run that calls such a tool is refused and the refusal is
kept with the run, and a routine proposal flags allowed tools outside its Topic.

**Goblin's own narrowing of its subagents stays.** A subagent is bounded by the chat that started it, read live, and
by the exclusions its spawner gave it (`subagent_config`, ADR 0018). That is the agent limiting its helper, not an owner
switch.

**An agent app built in a Topic whose apps are a list joins that Topic's setup** (with a receipt), so the agent can use
what it just built there.

Built-in tools are not part of a setup and stay available everywhere: files, search across Topics, Home, routines,
organizing and memory zoom. Paths that run outside any chat (skill learning, agent-app jobs with no conversation) are
the owner's acts and are not narrowed by a setup.

## Rejected

- **Per-conversation switches under the Topic.** Two knobs need precedence rules (a thread's "off" against a
  Persona's addition) and make "why is this off?" a question with three answers. A thread that needs another setup
  belongs in another Topic (Move exists, ADR 0034).
- **A Topic as a ceiling a Persona cannot exceed.** The owner wants Personas to bring their own tools; the owner's
  grants remain the ceiling.
- **Pinning a selected skill by exact URI.** A server that versions its URIs would make every selected skill
  unavailable on each release.
- **Persona-owned connections.** A Persona works with the owner's connections; separate credentials per Persona would
  need their own grants and storage.

## Consequences

- Deleting the switch rows could turn back on something an owner had switched off in one conversation; the counts
  deleted per agent are recorded and reported.
- Changing a Topic's subagents choice reconfigures the Pi tool filter of every chat in the Topic (a prompt-cache miss
  each). MCP servers, skills and apps reach the model through `mcp_list`, the context tail and execution checks, so
  changing them costs no cache.
- Editing a Topic's setup mid-answer takes effect at the next call: dispatch checks the live setup.
- The words: the UI says "MCP servers & skills"; code and docs say setup (`TopicSetup`, `PersonaSetup`). "Capabilities"
  is retired.
