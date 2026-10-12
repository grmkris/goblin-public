# ADR 0042: MCP 2026 client: live tool lists, URL requests and step-up

(MCP call approvals) and ADR 0041 (connections).

Sidequest's MCP server is adding three features of protocol 2026-07-28 that change what a connection can do while the
owner is using it:
- the tool list changes when the agent's roles or approval change, announced on a `subscriptions/listen` stream;
- an approval-producing call answers "input required: open this URL" (a multi round-trip request with a URL
  elicitation) instead of a link in its text;
- a call beyond what the sign-in granted answers HTTP 403 `insufficient_scope`.

goblin is the client the owner controls, so it implements the client side of each, and both are proven together.

## Decision

### Live tool lists

**A connection listens for tool changes only while it is in use.**
- After a 2026 connect, goblin opens `subscriptions/listen` for tool changes if the server advertises
  `tools.listChanged`.
- On `notifications/tools/list_changed` it re-lists the tools in place, within the same bounds as at open.
- It closes the stream 60 seconds after the owner's or the model's last use. The next such use re-lists first, then
  listens again, so nothing is missed. goblin's own background work (Events polls, notices, agent-app jobs) never holds
  it: in the showcase run every Events poll reopened a stream that idled out a minute later (amended 2026-10-12).
- A call to a tool goblin does not list re-lists once before refusing.

An open outbound stream keeps the agent's Durable Object awake and billed, and stops its WebSockets from hibernating.
Holding it only while in use lets the object sleep a minute after the last call.

### URL requests

**A URL request is a server asking the owner to finish something on its site before a call can complete.**
- Only the model's own calls (Goblin, a Persona, a routine run) offer to answer them. They declare URL elicitation per
  request, and only on a 2026 connection. The owner's tool console, MCP Apps and the dispatch of an ask-first approval
  never do, so servers answer those with a plain link as before.
- goblin accepts only url-mode elicitation. It keeps the request (the call's frozen arguments, the server's request
  state, the link and its message) for up to 24 hours, or until the routine run's deadline when that is sooner, and
  ends the turn.
- The owner sees a card with the server's message as text, the full link and its host, and a warning when the host is
  not the connection's own. They open it themselves; goblin never opens or prefetches it.
- **Done** retries the same call once with an acceptance and the server's request state. If the server is still
  waiting, the request stays open. Once the server answers, its result goes back to the turn that asked, as an
  ask-first approval's result does (ADR 0028). **Cancel** sends a decline.
- The model's tool result names the request but carries neither the link nor the message: transcripts are indexed, and
  approval links can carry one-time tokens.

### Step-up

**A call beyond what the connection's sign-in granted asks the owner to sign in again with more access.**
- A 403 `insufficient_scope` is its own error. It is not a failure of the server, so the connection stays open.
- The owner's card opens the server's consent in a new tab and asks for what the connection holds, what the server
  asked for and a refresh token; only when the held scope is not known, for everything the server offers (amended
  2026-10-12, so access the owner chose to leave out stays out). The new sign-in is a fresh authorization, never a
  refresh.
- The connection keeps its tokens until the new ones arrive. A step-up that is abandoned leaves it as it was.
- The owner presses **Continue** in the chat once signed in.

### Choosing access

**The owner can sign a connection in with less than the server offers** (added 2026-10-12). Choose access, on the
connection's card, lists the scopes a sign-in can ask for, starting from what the connection holds, else everything
offered. The sign-in asks for the ones the owner keeps, plus `offline_access` when offered, so the connection can
still refresh. A scope the server does not offer is refused before anything changes. A tool that needs more later goes
through step-up, for just that.

## Rejected

- **Declaring URL elicitation on the client.** Every call, including the owner's console, Apps and ask-first dispatch,
  would then receive requests it cannot answer and fail.
- **Holding the listen stream as long as the connection is cached, or always.** The Durable Object would stay awake for
  minutes after every use, or never sleep.
- **Re-using sign-in for step-up.** Connecting again drops the connection and its tokens before the owner has
  consented.
- **Only URLs on the connection's own host.** A server's approval pages may live on another domain; the owner decides,
  with the host shown.

## Consequences

- A new table, `app_mcp_url_requests`, keeps URL requests; it is added by its own migration, so dev keeps its data.
- Activity's Needs you counts open URL requests and step-ups, and a Persona's answer can hold either.
- An interrupted retry is recorded as uncertain, as an interrupted approval dispatch is: the server may already have
  acted. So is one the server answered with a result goblin cannot read or keep.
- The answer goes to the tool as it was listed when the server asked, even if the server has dropped it since:
  finishing the server's step can change its tools (amended 2026-10-12, after the showcase run). A cancel stands even
  if the server asks again.
