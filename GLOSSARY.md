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
The owner's permission for one tool of one connection. A tool grant also covers the App that tool declares.

**URL request**:
A server asking the owner to finish something on its site (approve a new agent, a role) before a call can complete.
The owner opens the link, then presses Done (goblin retries the call) or Cancel (ADR 0042).
_Avoid_: elicitation (in the app), prompt

**Step-up**:
Signing a connection in again with more access, when a call needs a permission its sign-in was not granted
(ADR 0042).

**Setup**:
What a Topic's chats work with: its connections, skills, agent apps and whether they may start subagents, each all of
what the owner allows or a list (ADR 0040). A Persona's setup is what it adds to the Topic's. A setup chooses; it never
grants.
_Avoid_: capabilities, switches, toolset, plugin

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
What the owner confirmed to happen on a trigger (once, a cron schedule or an MCP Event of a connection) in a Topic:
**Tell me**, **Hand to**, or both (ADRs 0012, 0041). A routine that hands over runs in its own run conversation and
reports back passively.

**Tell me**:
A routine's choice to notify the owner of everything it posts: an event's notice, a reminder, the answer of whoever it
handed to. Optionally also on Telegram.

**Hand to**:
Who a routine gives the work to: nobody, Goblin, or a Persona pinned at the revision the owner confirmed, each with
the owner's instruction, allowed tools and budget.

**Notice**:
What Tell me posts for an event or a reminder: a short message in the routine's Topic, attributed to the connection
(or the routine), plain text with at most one link. The model reads it as untrusted data, never an instruction.
_Avoid_: alert, ping

**Notification**:
A routine post the owner asked to be told about: listed in Activity's Notifications, counted in the Activity badge
until read.

**Telegram channel**:
The one MCP connection that carries Telegram for the agent (ADRs 0009, 0011): mygram's, directly or through mysi. The
owner's messages arrive in Main authored "Telegram", woken by a signed MCP Event or, from a server without Events, a
**doorbell**; answers go back through mygram's send tool.

**Conversation activity**:
What a chat is doing now: `working`, or `waiting` on its subagents.
_Avoid_: activity, on its own

**Activity**:
The rail's page of what waits on the owner across Topics: questions, approvals and grants in chats (a Persona's
included), agent apps whose schedules need the owner, notifications, connections whose events are not set up yet,
unread chats, and organize receipts to Undo.

**Tasks**:
The rail's page of work under way: Delegates, Personas answering and routines on a schedule.

**Home**:
The rail's first place: the channel this tab showed last. The Home dashboard of App tiles (ADR 0025) is deferred; its
saved layout is kept.

**Decision proposal**:
A suggestion the agent makes about the owner's own chats (a report worth attention, an exchange that could be a
thread, earlier work that may help), shown only to the owner as an "Only visible to you" row to confirm or dismiss. It
never acts on its own (ADR 0031).
_Avoid_: recommendation, automatic action

**Clef**:
The typed judgment model decisions ask through Workers AI, bound on dev only. It answers bounded questions and never
writes a reply.

## Connections, skills and apps

**Server**:
An MCP server's address, with the claims on its card (title, description, icon) that only the owner sees.

**Connection**:
The owner's account on a server, with a label they give it (e.g. "Sidequest · Hirer"), configured by the deployment
or added by URL, suggestion or registry. One server may have several. Each has its own sign-in, grants, ask-first
settings, skills switch and Events subscriptions (ADR 0041).
_Avoid_: server (for the account), integration, account

**mysi**:
The owner's own my* apps (notes, browsers, Telegram, email, skills, terminals) behind one sign-in and one connection
(ADR 0052). A product of its own, which the owner gets themselves; not part of goblin Pro.
_Avoid_: myapps (the code base behind it)

**Service**:
One app behind a gateway connection such as mysi. Its tools and Events carry its name in front (`mygram_inbox_read`,
`mygram.message.received`).
_Avoid_: server (the gateway is the server)

**Shelf**:
The servers goblin suggests on Connections and Start, in groups, each in goblin's own words; one tap adds and
connects. A server on it that needs no sign-in offers something Mercator does not already sell (ADR 0052).
_Avoid_: catalog (that is the registry search), marketplace

**First-class server**:
A server goblin knows by its own profile, matched by endpoint: our description, a recommended set of grants, a
status line read from one of its tools, its app one tap away and, for a paid tool, a spending rule (ADR 0043).
Mercator is one, and a connection every account starts with.
_Avoid_: featured, partner, built-in

**Spending rule**:
The owner's limit on a paid tool of a first-class server: jobs up to an amount run without asking, until a daily
total; anything else asks first. The server's wallet limit stays the hard stop (ADR 0044).
_Avoid_: budget (that is the model budget), allowance

**Skill**:
A procedure served by an MCP server through the MCP Skills extension. The agent follows skills only from servers the
owner turned skills on for, activates them per conversation as `<connection>:<name>`, and a skill never grants a
permission (ADR 0008).

**Skill draft**:
A skill the agent proposed to the owner's skills library after a correction; the owner accepts or rejects it there.

**MCP App**:
A sandboxed `ui://` resource served through the MCP connection that answered its tool call. One live App moves
between its place in the transcript and its page (`/a/<id>`), where goblin's composer stays at the bottom, without
reloading.

**Server App**:
A connection's own App (its global entrypoint), opened from its pin or its card. It lives in one thread of its own and
opens full screen (ADR 0053).
_Avoid_: service, entrypoint (for the App)

**Pin**:
A server or one App view the owner keeps in the sidebar's Pinned list, in their order, on every device. A connected
server with its own App is pinned until the owner unpins it. Pinning grants nothing.
_Avoid_: favourite, bookmark

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

## Goblin Wallet

**Goblin Wallet**:
The agent's wallet, its own MCP server and web app beside goblin: accounts, limits, signing and receipts. Any MCP
client can connect it; goblin connects it as a first-class server (ADR 0045).
_Avoid_: agentic wallet (the earlier working name), treasury

**Owner account**:
The owner's own EVM account, the embedded wallet Privy gives them at sign-in. It holds the funds the agent may draw on
and is upgraded with EIP-7702 so it can grant an allowance.
_Avoid_: main wallet, root wallet

**Agent signer**:
The wallet's signing key for the agent: a Privy server wallet the owner owns, on which Goblin Wallet is an additional
signer bound to a policy. It never exports its key and signs only for an operation.
_Avoid_: hot wallet, session key, bot wallet

**Allowance**:
On-chain only: the owner account's ERC-7710 delegation to the agent signer, capped per period by `ERC20PeriodTransfer`
and expiring. Not goblin's spending rule and not the model budget.
_Avoid_: budget, spending rule

**UserOperation**:
An ERC-4337 action from a 7702-delegated owner or agent address, sent by Pimlico's bundler instead of as a plain
transaction. Every EVM send of the wallet is one; its gas is paid in USDC (ADR 0050).
_Avoid_: meta-transaction, relayed transaction

**Paymaster**:
Pimlico's ERC-20 paymaster: it pays a UserOperation's gas and takes it back in USDC, up to the bound the batch
approves. Not the wallet's treasury.
_Avoid_: gas sponsor (nothing is sponsored; the user pays in USDC)

**Access key**:
On Tempo: a keychain key of the owner's Tempo account with a per-token periodic limit and an expiry, enforced by the
Tempo protocol.

**Wallet limit**:
A limit the wallet itself keeps for a connection: per call, per hour, per week, with an expiry, plus the allowed paid
services and the address book. Each limit shows the layer that enforces it: on-chain allowance, access key, signer
policy, wallet ledger or the client's spending rule.
_Avoid_: budget, cap (alone)

**Operation**:
One spend or signature with frozen terms (amount, token, chain, recipient, service, expiry), reserved against the
wallet limits before anything is signed and idempotent by its operation id. Payment and delivery are separate states.
_Avoid_: transaction (an operation may be several, or none), job

**Receipt**:
What an operation leaves: its terms, the payment evidence (transaction hash or the rail's receipt), the delivery and
the limits left.

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
goblin Pro, the one plan, without which the agent answers nothing; the agent keeps an active one for a minute (ADR
0015, 0054).
_Avoid_: free plan, tier (there is no free plan)

**Wallet subscription**:
Pro paid from the Goblin Wallet: a permission the owner signs once that lets goblin take at most one payment a period,
into its collector, for a fixed number of periods; cancelling is revoking it in the wallet, and Pro runs to the end of
the period paid (ADR 0054).
_Avoid_: recurring payment, auto-renew (nothing is charged without the signed permission, and the owner revokes it)

**Day pass**:
Pro paid by the UTC day: the deployment's price (US$1 by default) for each day the owner uses goblin, taken by the first
message of that day goblin answers, and nothing for an idle day (ADR 0054). The other way to pay is monthly.
_Avoid_: daily subscription, trial

**Collector**:
goblin's own wallet that wallet subscriptions pay into, the only recipient a subscription allows (ADR 0054).

**Grace**:
The days after a failed monthly renewal while Pro continues and goblin retries the payment each day; past it the
account loses Pro (ADR 0054). A day pass has none.

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
