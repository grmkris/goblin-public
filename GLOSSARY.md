# goblin

goblin gives every user a resident personal agent: their own Cloudflare Durable Object that talks with them, keeps
working while they are away and acts with the MCP connections they granted. These are the words the code, the docs
and the app use for it.

## People and authority

**Owner**:
The user an agent belongs to. Every signed-up user owns exactly one agent and reaches only that one.

**Agent**:
The owner's resident agent, one `PersonalAgent` Durable Object named by the owner's user ID.
_Avoid_: bot, assistant instance

**Resident authority**:
The agent's own standing permission to use the owner's MCP connections while the owner is away. It lasts 30 days,
renewed by the owner's activity, and the owner can revoke it in Settings.

**Inbound client**:
An MCP client (Claude Code, another agent) the owner authorized to call goblin's `/mcp`.

**Grant**:
The owner's permission for one tool of one outbound server. A tool grant also covers the App that tool declares.

**Capabilities**:
What one conversation lets its agent use: the owner's grants, skills libraries and subagents, narrowed by what was
switched off there (ADR 0010). Switches only narrow; they never grant.

## Conversations

**Chat**:
Any conversation the agent keeps (a Conversation, a thread, a subagent), named by a stable chat id that resolves to
its current Pi session.

**Topic**:
A channel of the owner's work: exactly one Conversation and any number of threads under it (ADR 0032). Personal is
the first Topic and holds Main.

**Conversation**:
A Topic's one long-lived chat. It never closes and keeps a memory instead of an ever-longer context.

**Main**:
Personal's Conversation, chat `1`. The owner's browser, inbound clients and Telegram talk in it, each message from
anyone but the owner's browser labelled with its author.
_Avoid_: root session

**Channel**:
A Topic's Conversation as the web shows it (`/c/<id>`, ADR 0036): `#` and the Topic's name in the sidebar.

**Thread**:
A side conversation in a Topic, branched from a message of any open chat or started empty under its Topic's
Conversation. Nothing in it reaches its parent unless the owner shares it back.

**Start thread**:
Sending a message as the head of a new Thread instead of into the channel; Reply in thread and "+" start one the same
way, one Thread per operation (ADR 0034).

**Move to thread**:
Moving a channel's newest finished turn into a new Thread, leaving the owner's message in the channel as the Thread's
head (ADR 0034).

**Thread panel**:
Where the web shows a thread beside its channel (a full view on a phone), threads opened inside it stacked with a back
crumb.

**Close**:
What the owner does to a thread or subagent instead of deleting it: it and everything under it stop and take no
messages, stay readable, and Reopen brings it back. A Conversation never closes.
_Avoid_: delete

**Read mark**:
When the owner last saw a chat's newest reply, kept by the server so every device agrees what is unread.

**Subagent**:
A background chat that a conversation starts with `subagent_spawn` to do one job. It posts its result back to its
spawner once, which does not answer it unless the job asked for synthesis, and closes when done.
_Avoid_: worker, child agent

**Delegate**:
A subagent as the owner meets it in Tasks and the transcript: its result arrives marked with its name.

**Persona**:
A named, versioned agent definition the owner tags with `@name`; each tagged Persona answers once, attributed, in the
same chat, without a Goblin run (ADR 0033).

**Organize receipt**:
The record of a change the agent made to a Topic or Persona at the owner's request, with the target before and after.
The owner can Undo it while nothing has touched the target since.

**Memory view**:
A Conversation's memory as the model reads it: one-line summaries of older messages, followed by the newest exchange
verbatim. `zoom` opens a line.

**Memory model**:
The cheap offered model (`GOBLIN_MEMORY_MODEL`) for thread titles, memory summaries and skill-draft decisions; its
tokens count toward the budget.

## Work on its own

**Routine**:
A prompt the owner confirmed that runs on its own (a reminder, a cron schedule or an MCP Event) in a fresh thread
under its Topic, and reports back passively (ADR 0012).

**Telegram channel**:
The one MCP connection that carries Telegram for the agent (ADRs 0009, 0011): the owner's messages arrive in Main
authored "Telegram", woken by a signed MCP Event or, from a server without Events, a **doorbell**; answers go back
with `send_message`.

**Conversation activity**:
What a chat is doing now: `working`, or `waiting` on its subagents.
_Avoid_: activity, on its own

**Activity**:
The rail's page of what waits on the owner across Topics: questions, approvals and grants in chats, agent apps whose
schedules need the owner, unread chats, and organize receipts to Undo.

**Tasks**:
The rail's page of work under way: Delegates, Personas answering and routines on a schedule.

**Home**:
The rail's first place: the channel this tab showed last. The Home dashboard of App tiles (ADR 0025) is deferred; its
saved layout is kept.

## Connections, skills and apps

**Outbound MCP server**:
A server the agent calls, configured by the deployment or added by the owner by URL, suggestion or registry.

**Skill**:
A procedure served by an MCP server through the MCP Skills extension. The agent follows skills only from servers the
owner turned skills on for, activates them per conversation as `<server>:<name>`, and a skill never grants a
permission (ADR 0008).

**Skill draft**:
A skill the agent proposed to the owner's skills library after a correction; the owner accepts or rejects it there.

**MCP App**:
A sandboxed `ui://` resource served through the MCP connection that answered its tool call. One live App moves
between its place in the transcript and its page (`/a/<id>`) without reloading.

**Agent app**:
A small program the agent wrote and goblin runs (ADR 0021): durable state, actions and views the agent calls with
`app_call`, and its own files. Not an MCP App, which a server serves.

**Release**:
One build of an agent app. One is active; earlier ones can be rolled back to, and failed ones keep their problems.

**Revision**:
The number of an agent app's state, one more with every change an action commits.

**Power**:
Something an agent app reaches beyond its state and files (a host, an MCP tool, the model, Telegram, another app); it
declares it, and the owner approves it.

**Schedule**:
An agent app's action that runs on its own, every 15 minutes to daily.
_Avoid_: cron job

**Block**:
A fenced `mermaid`, `chart` or `map` block in the agent's reply, drawn in place (ADR 0023).

**Kit**:
`@goblin/kit`, the one implementation of the drawn blocks, for the chat and agent apps.

**Files**:
The owner's files (ADR 0022): `/uploads`, what they uploaded or attached, and `/agent`, what the agent wrote. The
agent writes only `/agent`.

**Attachment**:
A file the owner sent with a message: its path rides with the words, and the message shows it.

## The agent's API and records

**Owner API**:
The typed API the owner's browser calls under `/api`: admitted at the Worker's edge, then served by the owner's own
agent (ADR 0038).
_Avoid_: RPC

**Account API**:
What the Worker answers without waking an agent: billing, inbound clients and browser crash reports.

**Internal API**:
The typed API through which the Worker reaches an agent for anyone but the owner's browser: an inbound client's ask
and reads, inspection, and the hooks. The browser can never reach it.

**Workspace feed**:
One stream per tab of what the workspace shows: every chat and its activity, the Apps, Topics, Personas and receipts.
The web keeps it in its query cache.

**Operation ID**:
The stable key that makes a submission idempotent: a retry with the same one finds the same result. Acceptance is
not external completion.

**Receipt**:
The record of one operation in a chat: what it was, who started it, the chat it made, the operation that led to it,
and how it ended. It proves admission, never completion.

**Flow**:
One content-free step of how people and agents move through conversations (a send, a thread started, a move, a
Persona's answer, a routine firing), recorded with its operation (ADR 0037).

**Reference**:
The short id a failure shows the owner (`… · ref 7f3a9c12`), which finds that request's log lines (`goblin lookup`).
_Avoid_: error id, trace id

**SingleFlight**:
The agent's one run per key across waits: a caller asking for work already running under that key joins it, or skips
it, and the work outlives the caller that started it.
_Avoid_: lock (`KeyedLock` admits one holder per key and is never held across a wait)

**Pi Durable / PiHarness**:
The conversation and execution runtime. It owns transcripts, tasks, recovery and tool replay; `PiHarness` is its
native Agents SDK adapter.

## Plans and deployment

**Plan**:
The account's subscription (Pro) that admits it to its agent; the agent keeps an active one for a minute (ADR 0015).

**Model budget**:
The estimated Token Plan Credits an agent may spend per UTC day (ADR 0026). Past it, new turns are refused and tools
inside a running turn are blocked.

**Sign-up mode**:
`open`, `invite` (an invite code is required) or `closed`.

**Stage**:
One deployment: `local`, `dev`, `prod` or a disposable `test_*` environment, each with its own resources and secrets.

**CLIProxy / LiteLLM**:
The model gateways: CLIProxy for local work on the build box, Railway LiteLLM for deployed stages, each with its own
capped key.

**Alchemy**:
The only infrastructure and local-workerd entrypoint.
