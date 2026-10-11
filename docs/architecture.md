# Architecture

One Cloudflare Worker serves the web app and the API. Behind it, every user has their own `PersonalAgent` Durable
Object, named by their user ID: it runs Pi, holds that user's outbound MCP connections and credentials, and keeps
application state in its own SQLite. D1 holds Better Auth's account tables (users, sessions, inbound OAuth) and goblin's `app_billing_*` tables.

```mermaid
flowchart LR
  Browser --> Web[TanStack Start]
  Web --> Worker[Worker routes]
  Client[MCP client\nClaude Code, agents] -->|Bearer| Worker
  Worker --> Auth[(D1\nBetter Auth)]
  Worker -->|owner and internal APIs over fetch, one RPC| Agent[PersonalAgent DO]
  Agent --> Pi[(Pi tables)]
  Agent --> App[(app_* tables\nDrizzle)]
  Agent --> MCP[MyPlan, MyBrowser\nOAuth, refreshed in the DO]
  Agent --> Model[Model gateway]
```

## Worker

`apps/web/src/worker.ts` sends pages to TanStack Start and the routes below to `apps/runtime/src/worker.ts`, whose
handlers are `http/worker.ts`.
Runtime paths below are relative to `apps/runtime/src/`; browser paths are relative to `apps/web/src/`.

| Path | What happens |
| --- | --- |
| `/health` | Stage, service name, sign-up mode, whether mail is configured, and the billing mode. |
| `/.well-known/oauth-protected-resource*` | Protected-resource metadata for `/mcp`, the same document at every path. |
| `/.well-known/*`, `/api/auth/*` | Better Auth: sign-up and sign-in, the OAuth authorization server for inbound clients. |
| `/mcp` | goblin's own MCP server; a Bearer token from an inbound client reaches the agent of the user who consented, and `goblin:inspect` adds read-only inspection (ADR 0024). |
| `/api/billing/…`, `/api/clients…`, `/api/client-errors` | The account API, answered in the Worker without waking an agent (see The owner API). |
| `/api/*` | The owner API: admitted at the Worker's edge, then forwarded to the signed-in user's own agent (see The owner API). |
| `/hooks/mcp-events/<userId>/<connectionId>/<token>` | One connection's signed MCP Events; the route token, bound to the user and the connection, is checked before object lookup, then the agent's internal API takes it (`mcpEvents`). |
| `/hooks/myagent/<userId>/<token>` | The Telegram doorbell, the fallback for servers without Events; the user-bound route token is checked before object lookup, then the internal API's `doorbell`. |
| anything else, `/internal/*` included | A 404 in the envelope: the internal API is reached only by the Worker, on the agent's stub. |
| `/hooks/dodo` | Signed payment webhooks (see Plans and payments). |

## The owner API

The browser's API is one typed Effect HttpApi contract ([ADR 0038](adr/0038-typed-owner-api-served-by-the-agent.md)),
in `packages/contracts/src/api`: `OwnerApi`, which each user's agent serves, `AccountApi`, which the Worker serves,
and `errors.ts`, the failure vocabulary (`AppError`) and its envelope.

**The edge** (`http/api/edge.ts`, built once per isolate). The account API's groups are answered in the Worker
(`http/api/account.ts`): `billing` for any signed-in account, `clients` for one with a plan, and `clientErrors`, a
browser crash report, without a session. Every other `/api/*` request is admitted in this order, then forwarded:

1. a write whose `Origin` names another site is refused;
2. the session comes from the cookie alone; a request with an `Authorization` header is refused;
3. every write needs the app's own `Origin` and `x-goblin-csrf: 1` (`http/csrf.ts`), which the web sends on every write;
4. the account's plan is read fresh from auth D1 (402 without one);
5. a body is capped at 64 KiB, except file bytes, which stream through to the agent's own limits;
6. `AGENTS.getByName(userId).fetch` gets the request with only `content-type`, `content-length`, `accept`,
   `last-event-id`, `x-goblin-request`, `x-goblin-operation` and `x-mcp-caller`, plus the edge's reference in
   `x-goblin-ref` (the request's cf-ray, or a random id where there is none) and `x-goblin-forwarded: owner`. Cookies
   and authorization stay at the edge. Only an `/api/*` path that is not the account API's is forwarded, as the parsed
   URL names it; anything else is a 404.

Every answer carries `x-goblin-ref`, `cache-control: no-store` and `nosniff`. Each failed one, the edge's refusals and
the agent's answers alike, is one `http.failure` log line: route template, method, status, code, reference, the
browser's request and operation ids, and the agent; never a body.

**The agent** (`PersonalAgent.onRequest`) answers with `AgentHttp` (`http/api/server.ts`): one router over every group's
handlers of the owner and internal APIs (`http/api/groups.ts`), built once inside the agent's runtime as one of its
layers, never at module level.
Each group's handlers (`HttpApiBuilder.group`) live in their area (`<area>/api.ts`) and read the agent's services
from context. Owner admission (the `OwnerAdmission` middleware, `http/api/middleware.ts`) admits every request
before its handler, and before its body is decoded: the plan through the agent's `Entitlements`, then a renewal of
resident authority, except where an endpoint is annotated `RenewsResident: false` (`POST /api/agent/resident`, the
event streams, the files group and the OAuth callback). It annotates the request's logs with `goblin.rpc`
(`<group>.<endpoint>`), `goblin.operation` and `ref`, and stamps `ref` on every typed failure.

| Group | Paths under `/api` | Handlers |
| --- | --- | --- |
| `conversations` | `/conversations`, `/conversations/:id`, and under it `messages`, `threads`, `move`, `stop`, `queue`, `read`, `composer`, `snapshot`, `history`, `sources`, `events` (SSE) | `chats/api.ts` |
| `inspect` | `GET /conversations/:id/details` | `inspect/api.ts` |
| `topics` | `/topics`, `/topics/:id`, `/topics/:id/setup` | `topics/api.ts` |
| `setup` | `GET /setup/catalog` | `setup/api.ts` |
| `personas` | `/personas`, `/personas/:id` | `personas/api.ts` |
| `organize` | `/organize/:id/undo` | `organize/api.ts` |
| `mcp` | `/mcp/servers`, `/mcp/suggested`, `/mcp/catalog`, `/mcp/registries`, `/mcp/registries/remove`, `/mcp/grants`, `/mcp/ask-first`, `/mcp/skills`, `/mcp/app-grants`, `/mcp/approvals/:id`, `/mcp/oauth/callback`, and `/mcp/:id/` `tools`, `events`, `connect`, `disconnect`, `remove`, `tools/call`, `resources/read` | `mcp/api.ts` |
| `resident` | `/agent/resident` | `mcp/resident-api.ts` |
| `agent` | `/agent/usage`, `/agent/model`, `/agent/channel` | `routines/agent-api.ts` |
| `memory` | `/agent/memory` | `memory/api.ts` |
| `routines` | `/routines`, `/routines/settings`, `/routines/:id`, and under it `confirm`, `pause`, `run`, `runs` | `routines/api.ts` |
| `apps` | `/apps`, `/apps/:id`, and under it `launch`, `state`, `call`, `diagnostics` | `apps/api.ts` |
| `agentApps` | `/agent-apps`, `/agent-apps/:name` | `agent-apps/api.ts` |
| `workspace` | `GET /workspace/events` (SSE) | `workspace/api.ts` |
| `files` | `GET /files`, `GET`/`PUT`/`DELETE /files/content` | `files/api.ts` |
| `decisions` | `POST /decisions/:id` | `decisions/api.ts` |
| account (Worker) | `billing`: `/billing/state`, `/billing/checkout`, `/billing/portal`; `clients`: `/clients`, `/clients/:clientId`; `clientErrors`: `/client-errors` | `http/api/account.ts` |

What is not JSON in and out is served through HttpApi's raw handlers, all annotated `RenewsResident: false`: the two
event streams (SSE), the owner's file bytes (streamed both ways, never buffered), and `mcp.oauthCallback`, a redirect
to Connections that carries `ref` when it failed. A streamed answer owns its body, past the request's scope. Any path
no endpoint names is a 404 in the envelope.

A failure answers the envelope `{ error: { code, message, recovery?, …safe fields, ref? } }`: `code` is the
`AppError` tag in lower_snake_case, which the typed client decodes back into the class, `message` and `recovery` are
fixed copy (`ERROR_COPY`), and the safe fields are the ones the UI uses (`reason`, `what`, `connectionId`, `name`,
`state`, `subscribe`, `limit`, `resetsAt`, `rpcCode`). Of a request that does not decode, a path parameter that does
not parse is 404, and a body, query or header that does not match is 400. A
failure from stored data, a response that does not encode, or a defect is a 500 `Internal`, reported with its stack
locations and never its message. The Worker's own routes (`/mcp`'s failures aside) answer the same envelope.

Callers that are not the owner's browser reach the agent through its internal API (`InternalApi`, `/internal`, exported
only from `@goblin/contracts/internal`), which the Worker calls on the agent's stub with a typed client
(`inbound/client.ts`) after its own check of the caller (a bearer token, a hook's route token; it reads no plan of its
own): `ask`, `recent` and `inspect` (inbound `/mcp`), `doorbell` and `mcpEvents` (the hooks). Its gate (`InternalGate`,
`http/api/middleware.ts`) refuses a request carrying the owner forward's mark and checks the plan the agent keeps unless
the endpoint says otherwise (`RequiresPlan`: `inspect`); it never renews resident authority. One Durable Object RPC
method remains, `deleteAgentData` (account deletion): Workers RPC drops custom error classes, so it returns an encoded
`RpcResult` (`http/rpc.ts`) that the Worker unwraps.

### In the browser

`lib/api.ts` builds two typed clients over the query bridge (`lib/query/api-query.ts`, a port of myapps'
`@myapps/query` with its provenance in `lib/query/PROVENANCE.md`): `owner` (`OwnerApi`) and `account` (`AccountApi`).
Every request carries a fresh `x-goblin-request` id, every write `x-goblin-csrf: 1`, and a write run with
`withOperation` its `x-goblin-operation`. Besides them, only the file bytes (`lib/files.ts`), the two event streams
and Better Auth's client (`/api/auth`) reach `/api`. Server data follows myapps ADR 0013, as
the web's instructions spell out:

- One `src/<feature>/queries.ts` per feature holds its `owner.apiQuery` and `owner.apiMutation` factories and its
  keys (`<feature>Keys`, rooted at the feature's name); the hooks over them live in `src/<feature>/hooks.ts`. A
  mutation's callbacks reach the cache through TanStack's `context.client`, and its `onSuccess` returns its
  invalidation.
- The `QueryClient` is made per router (`router.tsx`): data stays fresh for 30 seconds, only a retryable failure is
  retried, and a read that finds the session gone clears the cache and goes to sign-in.
- Owner pages render inside `OwnerGate` (sign-in on the page, `/subscribe` without a plan), not a signed-in layout. A
  route loader may prime a read with `primeOwnerRead` (`lib/prime.ts`), which runs ahead of the gate and decides
  nothing. Components read with `useSuspenseQuery` inside a `QueryBoundary` (`lib/query/query-boundary.tsx`), which
  keeps a failure inline with its reference and a retry; a section that reads with `useQuery` shows `QueryError`.
- The workspace feed writes into the same cache (`lib/workspace/`): each slice (conversations, activity, apps, topics,
  personas, invocations, receipts, proposals) is a query under `['workspace', slice]` that never goes stale, filled from
  the stream's snapshot and changes, and a change that makes another feature's reads stale invalidates them through one
  map (`lib/workspace/invalidations.ts`). The conversation stream stays a dedicated SSE store that only invalidates.
- A failure reads through `messageOf` or `describeError` (`lib/query/app-error.ts`) and quotes its reference. A route
  that fails shows `ReportedRouteError`, which reports a defect as a crash (see Logs, failures and references).

The web's tests serve the real contract in memory (`fakeHttpApi`, `lib/query/testing.ts`).

## Per-call MCP approval

The owner grants a tool under Connections, then can select **Ask first**. This local policy is independent of remote
annotations. Pi's `beforeTool` prepares an encrypted, immutable approval; `mcp_call` records a terminating approval
request. The chat card fetches the owner-bound record and shows its redacted arguments, including public
`operationKey` and asset fields. Approve once dispatches the original arguments; Refuse dispatches nothing.

The shared MCP manager enforces this policy for model, routine, subagent and App callers. Approval binds the endpoint,
grant version, arguments, caller, conversation, task and call id. Current resident authority and execution scope are
checked after connection waits and again at HTTP dispatch. A compare-and-set records dispatch intent once; automatic
OAuth retries cannot reuse it. Reconstruction marks an interrupted dispatch uncertain and never replays it. Routines
release their executing slot while waiting and resume the same run. Direct owner console calls are explicit owner
acts; autonomous App calls to ask-first tools are refused. See [ADR 0028](adr/0028-mcp-call-approvals.md).

## Accounts

Email OTP is the sole login method. A six-digit code expires after 600 seconds, permits five attempts and is stored
hashed in Better Auth's verification table. Sending is limited to one code per address per minute and ten sends per
IP per hour; sign-in permits twenty attempts per IP per five minutes. D1 holds rate limits because auth is created
per request. `GOBLIN_SIGNUP_MODE=open` admits new addresses; `invite` requires `GOBLIN_SIGNUP_INVITE_CODE` in the
`x-invite-code` header on both send and verify; `closed` permits only existing accounts. A successful OTP creates an
email-verified account or signs its owner in. Password, reset, verification-link and passkey endpoints are unavailable.

Every stage requires a mail sender. Deployed mail uses Cloudflare Email Sending from `hello@goblin.surf`; local
workerd captures `.eml` files through Alchemy's simulator. Better Auth 1.7.6 swallows mail callback errors, so a
request-scoped delivery flag and after hook erase an undelivered code and return 503. No account or session is created
by sending a code. The browser's OAuth provider client carries the authorization query through OTP login to consent.

The agent a request reaches derives from the session's user ID or the inbound token's subject. The Telegram hook
verifies a token bound to its user ID before selecting an agent. Deleting an account requires a sign-in from the last
600 seconds, with an explicit Settings confirmation. It first erases the user's agent through `Agent.destroy()`:
Pi, Agents and application tables, its alarm and isolate. Only then does Better Auth delete the user and D1 cascade
sessions, consents and tokens. Agent-erasure failure leaves the account intact for retry. Outbound OAuth tokens are
forgotten, not revoked remotely. Conversations, credentials, grants and resident authority belong to one user.

## The agent object

`PersonalAgent extends Agent` and registers the native `PiHarness` with the Agent lifecycle. Pi owns transcripts,
tasks, submissions, recovery and tool replay. PiHarness and Pi Durable are experimental; Alchemy is a pinned beta and
Drizzle an RC. `@shadcn/react` is pinned at 0.3.1 and patched (`patches/shadcn-react/README.md`): its MessageScroller
carries unreleased upstream fixes. The owner reaches the object through its typed API (`onRequest`, see The owner
API) and the Worker's other callers through the internal one; one RPC method is left, `deleteAgentData`.

The object's constructor migrates the application tables first (synchronously, as the Agents SDK makes its own): the
lifecycle's start opens Pi, whose apps and run ledger read them, before `onStart`, and an RPC or the runtime may come
before either. The object builds one Effect `ManagedRuntime` lazily, on first use, from `AgentLive`
(`layers/index.ts`). A runtime that fails to start is dropped, so the next caller starts it again; `deleteAgentData`
closes it. What the services need from the instance (its storage and env, the Pi pieces and kits its constructor
made, the schedules it arms, the plan policy) is one record, `AgentInput` (`runtime/input.ts`). The layers build in a
fixed order, each over everything before it:

- **Core** (`layers/core.ts`): `AgentInput`, the application database (`Db`), the change bus (`Changes`), Pi's calls
  as Effects (`PiSessions`), the per-key lock (`KeyedLock`), keyed single flights (`SingleFlight`), conversation flow
  events (`FlowEvents`), the plan the agent keeps (`Entitlements`), resident authority (`Resident`), and goblin's
  content-free logger and failure reporter in place of Effect's defaults (see Logs, failures and references).
- **The start** (`layers/index.ts`): the agent's start, step by step in one fixed order, each step a layer in its
  owning area's file and built after every step before it, so each await holds up the steps after it. In order: the
  MCP host (each server's endpoint binding checked, so a re-pointed server loses what it had, the credential cipher,
  held calls a restart cut off recovered); the cheap models; helper execution restored; the retained Pi filters
  retooled once; routine runs, with their usage projection subscribed to Pi's commits; main registered; the App
  registry; every Topic Conversation given memory; skills and the learner; the Telegram channel; and Events, with the
  Telegram and skills consumers registered before any delivery (the routines layer registers the routine trigger,
  before the agent runs anything). A stateful object is made once, by its step, and shared as that step's service;
  programs use the area's services.
  The conversation services publish `conversations.changed` with what each write changed, from inside the write; the
  App registry and the workspace feed follow that topic. A move a restart interrupted finishes once the conversation
  layer is built (`Moves` forks its reconcile in the layer's scope), never holding up the start.
- **One layer per area** after the start, in order: the model budget and picker (`Budget`, `Models`, which a send's
  admission reads), conversation (`Chats`, `ChatOperations`, `Conversations`, `Moves`), setup (`Setups`),
  knowledge (`Memories`, `Retrieval`), delegation (`Topics`, `Personas`, `Invocations`, `Receipts`, `Home`), routines
  (`Routines`, `RoutineControl`), inspection (`Inspection`), apps (`AppEngine`, `Files`), typed decisions (`Decisions`),
  the workspace feed (`Workspace`) and HTTP (`AgentHttp`). The MCP host's `McpConnections`, `McpServers`, `McpGrants`,
  `Approvals` and `Cipher`, and `CheapModels`, `RoutineRuns`, `RoutineUsage`, `Apps`, `Skills`, `Learner`, `Channel` and
  `Events`, are served by their start steps.

`AgentServices`, every service a program may require, is derived from the layers, so no area edits a shared union. A
service is a `Context.Service` tag in its area (`<area>/service.ts`) whose methods are `Effect.fn` Effects with typed
`AppError` failures. A synchronous Drizzle store is a set of functions of the agent's database (`Db`), or a plain
class where it keeps state, wrapped once where its service is built; nothing builds a second of a stateful one. The
Worker runs its own programs (the edge, the fresh plan reads, billing, the internal API's client) through `runAtEdge`
(`http/api/edge.ts`).

Inside the agent there are exactly two ways into Effect (docs/agents/effect.md), and programs use
neither: they compose. `tools/graph.ts` closes both to the files it lists (`boundaries/no-closed-import`).

- **The bridge** (`runtime/bridge.ts`), for code the runtime does not own: the Pi extensions and kits, the alarms,
  the apps engine and its Dynamic-Worker powers, and `onRequest`. `run` checks the plan (`requirePlan()`) first,
  `local` does not (the ledger, budget records, routine gates, diagnose), and both reject with the `AppError` the
  program failed with; `exit` returns the program's exit, which `onRequest` answers. Every program it runs reports an
  `Internal` failure or a defect with its code location (`runtime/instrument.ts`). `agent.ts` hands the bridge to
  what it builds; `AgentInput` does not carry it.
- **`promiseWith(context)`** (`runtime/boundary.ts`), for a foreign callback wired inside a layer that must answer a
  Promise: the MCP SDK's auth provider and dispatch guards, and the skills guard. It rejects with the typed failure
  itself, so an `AppError` crosses the SDK unchanged.

Erasing the agent disposes its runtime, whose layers' finalizers close every MCP connection.

- `KeyedLock` (`observability/lock.ts`): mutual exclusion per key, strictly first come, first served (Effect's
  `Semaphore` wakes waiters in no fixed order). It is held for admission only, never across a model call or another
  wait. Topic creates, retrieval catch-up, an agent app's state changes, chat admission (`chat:<id>`, which the mover
  and every passive write take too) and a thread operation (`thread-op:<op>`) take it. The Telegram pull, whose order
  does not matter, is serialised by the channel's own `Semaphore(1)`.
- `SingleFlight` (`observability/single-flight.ts`): one keyed run at a time across waits, forked in the layer's scope
  so interrupting its first caller does not cancel it. `run` joins every caller to it: an MCP token refresh
  (`mcp.refresh:<server>`) and connect (`mcp.connect:<server>`), a skills listing (`skills.listing:<server>`) and a
  move's remaining steps (`move:<op>`). `skip` answers at once while one is in flight: naming a thread
  (`naming:<chat>`), the skill learner (`skills.learn:<conversation>`) and a decision's judgment (`decision:<id>`).
- `Changes` (`runtime/changes.ts`): a synchronous topic bus with no fibers or timers. An area declares its topics where
  it publishes them, with ids as payloads (`conversations.changed`, `topics.changed`, `personas.changed`,
  `invocations.changed`, `receipts.changed`, `apps.changed`, `apps.removed`, `agent-apps.changed`, `home.changed`,
  `decisions.changed`), and
  the workspace feed reads each item as it is then. Handlers run inline in order; a failing one is reported and ends
  only itself.
- `PiSessions` (`pi/sessions.ts`): Pi's submit, write, wait, abort, model choice, event stream and reads as Effects
  with a typed `PiFailure`. Every call names its session, and interrupting a `wait` ends only the wait.

Conversations (`chats/conversations/`): every agent has one **main** conversation, stable chat id `1` (`PRIMARY_CHAT`),
where the owner's browser and every inbound MCP client talk. The chat directory (`chats/directory.ts`, read through
`Chats`) resolves that chat to its current Pi session. A fresh agent starts with Pi's root session `1`; `/c/1` stays the same whatever session it names. A message
from anyone but the owner's browser starts with an author tag block (`[from Claude Code]`, the `authorTag` contract),
so the model and the web both know who wrote it. Side
**threads** are Pi conversations of their own: branched from a message of any open conversation (a Pi fork at that
entry, so the thread sees its parent up to there and the parent never sees the thread), at any depth, or empty under
main (ADR 0017). `app_conversations` registers each one as a chat tree (`parent_session`: its parent chat), with its
kind, title, origin and close time. Its existing `session_id` primary key is the stable chat id (`chatId` in Drizzle);
`pi_session` names the current Pi session, uniquely owned by that chat, and `role = 'primary'` marks Main (`epoch`
is kept, unused: nothing rebinds a chat). Every chat row goes in through one inserter, `registerChat`
(`chats/directory.ts`; `Chats.register` for programs). A helper's immutable `spawner_session` keeps its anchor and
relays on the Pi session that started them.
A chat id reaches Pi only after the directory resolves its registered session, so no request opens a conversation by
guessing its number. Pi cannot delete a conversation, so Close stops a
conversation and everything under it and keeps it readable until Reopen; main never closes. The web
shows the Topics as channels in the app's sidebar (`components/shell/sidebar.tsx` over the pure `lib/topics.ts`):
Personal first, then by name, the archived folded at the end, each bold with a dot while it has unread replies and a
pulse while its agent works, with one flat level under it of its threads at work, unread, recently opened in this
browser or showing now (`topicThreads`); the open agent apps follow. A server without Topics implies Personal alone,
holding Main, and shows no Topic controls. With Topics, Add topic names a new one (`POST /api/topics`, one operation id
per opening of the dialog) and opens its channel; the channel's `#name` opens its menu: Rename, Exclude from search or
Include in search, and Archive or Restore (never Personal), all `PATCH /api/topics/:id`. An archived Topic's channel
shows a banner with Restore in place of its composer.
Unread is the server's: `read_at` on
`app_conversations` is the owner's read mark, set when a chat has been shown for a moment (half in view, the page in
front). A channel is `/c/:id`; its threads open in the thread panel beside it (ADR 0036, `components/shell`):
`/c/<channel>?thread=<id>` names the thread on top, `stack=` the threads under it where its parents would not derive
them, and `reply=<chat>-<entry>` or `reply=new` a draft on top (`lib/panel.ts`); a thread's or subagent's own `/c/<id>`
opens its channel with the panel showing it. Under the message a thread started from, a summary (reply count, when the
last reply came, a dot while unread, a pulse while it works) opens it; threads opened inside a thread stack with a back
crumb. A message offers Reply in thread, Copy and Details in a small toolbar over its top edge where a pointer rests,
and on a touch screen once the message is tapped. Reply in thread opens a draft in the panel, with the focus in its
composer, that branches the thread only when it is sent, because Pi cannot delete a conversation; `/new-thread` moves the
composer's draft into a new thread's draft the same way. A draft's (Reply's or "+"'s) first send is one call of the
thread operation under the draft's one operation id: it makes the thread and sends that message as its first. A send
meanwhile waits for the same thread and goes into it as a message of its own, and a retry asks for the same thread
again (`lib/draft-thread.ts`, `components/shell/thread-start.ts`). Details opens a sheet of what ran behind the message
(`GET /api/conversations/:id/details?entry=`, the inspect group): its operation in a few lines, its steps in order with
their status and duration, the operations it led to, and what was not recorded; a message with nothing recorded says
so. The channel and the panel follow conversations through one
stream pool (`lib/stream-pool.ts`): one event stream per conversation however many show it, at most eight following
beyond those on screen, and one off screen stops following after ten seconds, resuming from a fresh snapshot when it
comes back. Start thread, a toggle in the composer (and `/new-thread`), posts the message as the head of a new thread whose
reply lands there (`POST /api/conversations/:id/threads` anchored at `latest`; the runtime writes the
`app.thread_head` into the chat it started from), and the panel opens on it; turning it off keeps the draft, its
files and references. Move to thread, in the toolbar of a channel's newest owner message (`POST …/move`,
`movableEntry` in `lib/threads.ts`), waits while that turn's reply streams, then leaves the message as the thread's
head and opens the thread; a refused receipt's reason (`not_latest`, `awaiting_approval`, …) shows as one short line
under the message until the turn changes. The transcript draws what those runtimes write
(`components/parts/drawn-parts.tsx`): a thread's head with the thread's summary ("Moved to a thread" for a moved
turn, whose own entries a later entry's edits omit), the owner's message to Personas with whom it went to, a Persona's
answer and a Delegate's result as attributed messages (a mark, a name, Persona or Delegate), and a Topic's brief.
Personas still answering show after the transcript ("answering…", from the feed's invocations). With Personas on the
server the composer offers them as `@` references (with their avatars), and with two or more tagged a Together or
In turn choice that is sent as `personaOrder`. What an answer used from other chats shows as a strip under it: a
`search_chats` call's `SourcesDetails`, and automatic retrieval from `GET /api/conversations/:id/sources`
(`lib/sources.ts`), each source opening its chat. Owner-only messages (`EphemeralMessage`, "Only visible to you")
have a slot after the entry they follow and a provider (`components/shell/ephemeral-slot.tsx`); acting on one or
dismissing it hides it at once, and a refusal brings it back. Decision proposals fill it (see Typed decision
proposals).
A thread started with "+" tells its channel its name once it has one (ADR 0010): the channel gets one
`app.thread_started` note, `[thread started: "<title>"]`, and its transcript shows that thread's summary.
**The thread operation** ([ADR 0034](adr/0034-move-to-thread.md), `chats/thread-heads.ts`) is one idempotent call for
Reply, "+" and Start thread: `POST /api/conversations/:id/threads` with `StartThread` (`{ operationId, anchor, message,
personaOrder? }`) makes the Thread at `anchor` (`{ entry }` forks there, `empty` starts one under the Conversation the
chat sits under, `latest` forks at the chat's newest entry outside a running turn, or starts empty when it has none),
in the same Topic, then submits `message` into the Thread through the ordinary owner path as `<operationId>:first`,
with its Persona order. For `latest` (Start thread) it first writes an `app.thread_head` entry (`ThreadHeadData`,
request id `thread-head:<op>`) into the chat as a passive write whose model text is a bounded `[the owner started a
thread: "…"]`. `app_conversations.origin_op` (unique) makes one Thread per operation id, also for concurrent repeats,
and `POST /api/conversations` with an `operationId` goes through the same path. The web keeps a Reply or "+" draft in
the browser until its first send, which is this one call.
**Move to thread** (ADR 0034, `chats/mover.ts`) moves a channel's newest finished turn into a new Thread:
`POST /api/conversations/:id/move` with `MoveToThread` returns a `MoveReceipt` (the same operation id, the same
receipt). The Thread is a Pi fork of the chat at the turn's last entry, made a thread in its Topic, whose setup it
works with; the chat keeps its session and gets an `app.thread_head` (`moved: true`, request id `thread-head:<op>`) whose
model text is only `[moved to thread "<title>"]` and whose Pi `edits` omit the turn's own entries from the chat's
model context. Helpers the turn started report to the Thread from then on (their relays are handed over), the threads
branched from the turn and its App placements move under it, the chat's memory forgets the turn
(`forgetFrom`; its collector skips omitted entries), and the transcript index gives it to the Thread. A
turn still running, an older turn, a turn already moved and a turn waiting on an MCP approval are refused with a
reason (`streaming`, `not_latest`, `moved`, `awaiting_approval`). Each move is an `app_chat_moves` row (`requested`,
`forked`, `settled` or `refused`) that a restart finishes. The running-turn identity swap was built and measured
first; it hit the latency kill criterion and is not shipped (ADR 0034).

Queued inputs in Main and ordinary threads stay in Pi's native `InboxDoc`. The browser projects native inbox IDs
and modes, then reads contents through `GET /api/conversations/:id/queue`; helper and routine queues are absent
from this view, and passive writes are excluded. The shared conversation stream owns one cancellable queue read,
refreshes on snapshots, inbox updates and accepted sends, retains last-known contents during errors, and retries with
backoff. Native membership filters every response so stale reads cannot resurrect placed inputs. Both full and inline
composers show the same ordered queue outside the transcript and turn map. An unchanged failed draft reuses its
operation ID; acceptance clears it, so deliberate repeated messages get distinct submissions.
Each queue row has a Remove action. `DELETE /api/conversations/:id/queue` checks the registered owner conversation
and input type, then calls Pi's native `abortSubmission` with the conversation ID. Pi removes only a waiting input;
placement winning the race returns `already_started` without interrupting the run. Repeated removal returns a settled
outcome. Only the selected row is busy, failures keep it visible, and native inbox updates refresh every view.

The conversation-scoped routes of the owner API: the `conversations`, `inspect`, `workspace`, `files`, `apps` and
`agentApps` groups (a raw handler marked raw). Like every owner write, each write needs the CSRF header.

| Route | Purpose |
| --- | --- |
| `GET /api/workspace/events` | Raw. The workspace feed (SSE): a `WorkspaceSnapshot` of every conversation and kept App and what each conversation that is not idle is doing (`working`, `waiting` on subagents), then batches of `WorkspaceChange` (`workspace/live.ts`, from Pi's task graph and the registries' writes). A tab skips any item or change it cannot read, so a newer server never stops it. |
| `POST /api/apps` | Keep the App of a call in a conversation (`{ conversation, callId }`): one made before Apps were kept, or one closed. The call must be an `mcp_call` whose tool still renders that App; the same call keeps the same App. |
| `GET /api/apps/:id/launch` | What loads an App (`AppLaunch`): an MCP App's server and `ui://` resource, and the call's arguments and redacted result read back from Pi; an agent app's view module, stylesheet, frame bundles and state. It grants nothing. |
| `PATCH /api/apps/:id` | Close or reopen an App (`{ closed }`). Closing a conversation closes its MCP Apps. |
| `GET /api/apps/:id/state` | An agent app's state now, with its revision and release (`AppSnapshot`). |
| `POST /api/apps/:id/call` | An action an agent app's view calls (`AppCall`: name, arguments, the frame's operation id). Answers the state after it, or the app's own error (`AppCallResult`). |
| `POST /api/apps/:id/diagnostics` | A failure an agent app's view reported (`AppDiagnostic`); kept with the app's events at most every ten seconds. |
| `GET /api/agent-apps` | The owner's agent apps, newest change first, those without a view too (`AgentAppSummary`). |
| `GET /api/agent-apps/:name` | One agent app in full: versions, powers, schedules, today's use, files, recent events (`AgentAppDetail`). |
| `POST /api/agent-apps/:name` | A change by the owner (`AgentAppChange`): roll back, pause or resume a schedule, run one now, move its home, allow or revoke a power. Only the owner answers a power; the agent cannot. |
| `DELETE /api/agent-apps/:name` | Erases an agent app once the owner typed its name (`DeleteAgentApp`): tools, schedules, files and rows. |
| `POST /api/conversations` | The thread operation without a message (`CreateConversation`): an empty thread (`{}`, under `topic`'s Conversation when given) or a branch of an open conversation at an entry (`{ from: { conversation, entry } }`); 201 with its `ConversationView`. With an `operationId` the same id finds the same thread; without one each call makes a new one. |
| `PATCH /api/conversations/:id` | Rename, close or reopen (`closed`) a thread or subagent, or pin a subagent open (`keepOpen`). Closing stops it and everything under it; main cannot be changed this way. |
| `PUT /api/conversations/:id/read` | The owner has seen its newest reply: `read_at` moves forward to now, and the feed carries it as `readAt` (a later `lastReplyAt` is unread). |
| `GET /api/conversations/:id/composer` | Conversation-scoped connected servers, enabled skills by stable URI, existing helpers and unavailable libraries. |
| `GET /api/conversations/:id/queue` | Ordered queued input IDs, modes and contents for Main and ordinary threads, from Pi InboxDoc. Passive writes, helpers and routine inputs are excluded. |
| `DELETE /api/conversations/:id/queue` | Remove a queued input by positive safe-integer `submissionId`. Returns `removed`, `already_started`, `already_settled` or `not_found`; never stops a running input. |
| `POST /api/conversations/:id/threads` | The thread operation (ADR 0034): `StartThread` makes a Thread of this chat at `anchor` (`{ entry }`, `empty` or `latest`, which also posts the message as its head here) and sends `message` there as `<operationId>:first`. Returns 201 `{ thread, receipt }`; the same `operationId` returns the same Thread (another chat's is 409). |
| `POST /api/conversations/:id/move` | Move to thread (ADR 0034): `{ entry, operationId }` moves the newest finished turn the owner's message `entry` started into a new Thread. Returns the `MoveReceipt` (`state` `settled` with `thread`, or `refused` with `reason`); the same `operationId` returns the same receipt (another chat's is 409, a move already in flight in the chat is 409). |
| `POST /api/conversations/:id/messages` | Submit `input`, a stable `operationId`, optional `appContext` (by App id), up to eight `attachments` (owner file paths that must exist) and up to sixteen stable composer `selections`; skill-only input is allowed. Returns 202 acceptance. |
| `GET /api/files?dir=` | A directory of the owner's files (`FileListing`): `/uploads`, `/agent` or a folder under one, with the storage in use. |
| `GET`, `PUT`, `DELETE /api/files/content?path=` | Download or write (raw: the body streams, `content-length` required) or delete one of the owner's files. Downloads are attachments, except PNG, JPEG, GIF and WebP, which open in place; all are sandboxed by CSP. No files endpoint renews resident authority. |
| `POST /api/conversations/:id/stop` | Stop a conversation or one `operationId`, and the subagents it started (not its threads); answers `{ stopped }`, whether anything was running. |
| `GET /api/conversations/:id/snapshot` | The chat's Pi snapshot as JSON. |
| `GET /api/conversations/:id/events` | Raw. The chat's Pi events (SSE): a snapshot followed by committed batches. |
| `GET /api/conversations/:id/history?before=<entry>` | Earlier entries, oldest first, with a `more` flag. |
| `GET /api/conversations/:id/sources` | What the chat's answers retrieved from other chats (`SourceUse[]`, newest first, empty results left out): the source strips (ADR 0035). |
| `GET /api/conversations/:id/details?operation=` or `?entry=` | The `inspect` group: what happened behind one message, its operation's timeline (with its turn when it ran one) and the operations related to it (`InspectDetails`, ADR 0037). |

Every thread runs the `goblin.thread` extension (`pi/thread.ts`), added to that conversation alone when it is made;
main never has it. It tells the model it is in a side thread and offers `share_back`: when the owner asks (the
thread's "Share to …" button sends that request), the model writes a short note into the conversation the thread
branched from as a Pi write submission, an `app.shared` entry labelled `[from thread "<title>"]` that keeps the
thread's id, so the label in that transcript opens the thread. The parent's model sees it from its next request and
answers nothing, since a write starts no run. A thread branched from a subagent is made a thread: it gets the host's
extensions and `ask_user`, without the subagent's own selection and instructions. After each response an untitled thread is named by the memory model
from its latest exchange, in the background; the owner can rename it. A thread started with "+" is created with
`app_conversations.main_note = 'owed'`; once it has a title (the model's or the owner's) the same hook writes main
an `app.thread_started` entry with request id `thread-started:<id>` and marks the note `written`. The note carries
only the name, never what was said in the thread, and a later rename does not rewrite it. Branched threads already
show under their message in main and get no note.

Main and threads can start **subagents** with the subagent tools (`pi/subagents.ts`, after Pi Durable's background
subagent example): `subagent_spawn`, `subagent_send`, `subagent_stop`, `subagent_config` and `subagent_status`, one typed tool per action
(ADR 0027). A subagent is a Pi conversation owned by a background anchor task of its spawner, so the spawner's Stop
and idle waits do not reach it. It starts with the spawner's model and is given exactly the persona, the owner's MCP
and budget extensions, skills, files, code execution, app calls and the subagents extension again. Owner questions,
Home, routine and app management, memory and skill learning remain absent. Spawn exclusions and `subagent_config`
narrow servers, tools, skill libraries, apps and delegation against every live ancestor. Retained helpers get the
current extension selection through Pi configuration on reconstruction (ADRs 0018 and 0029). Each message goes through a relay task in the
spawner (`pi/subagent-relay.ts`): it delivers the message, waits until the subagent is done (idle, with none of its
own relays live; it parks on those), then posts the newest answer once into the spawner's chat as a passive `app.delegate_result` (`[from
subagent <name>]` to the spawner's model, which sees it at its next turn and does not answer it), or as an input the
spawner answers once when the spawn set `synthesize: true` ([ADR 0033](adr/0033-personas.md)). Request ids keep a restart from delivering or reporting twice; of
several messages on their way to one subagent only the last relay reports, quoting what the owner wrote. The subagent
then closes as done unless the owner wrote to it, branched from it or pinned it; a later message from its spawner
opens it again, while one the owner closed refuses its spawner. The owner's message to a subagent pins it open and
steers it when it is busy. Stop and Close stop the relays carrying to each subagent before aborting it, so a job cut
short reports nothing. The relay registers the subagent in `app_conversations` under its spawner, so the web lists it
there. In the spawner's transcript a spawn or send shows the subagent itself, live from the workspace feed
(`components/parts/subagent-block.tsx`, `lib/subagent-state.ts`): its state and clock, how many work under it, and
Stop (which asks first), Keep open, Dismiss or Reopen, opening to its task and its own subagents at any depth. A
report reads as "<name> reported back" with the report quoted, a subagent opens in the thread panel with "Task from
<spawner>", and
its composer steers it.

The shared native-textarea composer (`components/composer.tsx`, ADR 0029) opens `/` for skills and local commands and
`@` for connections, skills and helpers. Selected chips submit stable identities; unselected tokens remain prose.
`composer.ts` resolves current labels, live scope and verified skill instructions before model work. A connection
selection is a neutral hint; a helper selection adds its newest reported answer as bounded untrusted context here.
Structured composer metadata keeps selected labels and prose readable in the transcript. Failed resolution rejects
the complete send and marks its chip. `/new-thread` transfers the draft and portable attachment store to a new
thread's draft in the panel.

**Chat admission** ([ADR 0030](adr/0030-logical-chats-over-pi-sessions.md), `chats/operations.ts`): every input into a
chat (the owner's message, an inbound client's ask, the owner's Telegram message) takes one admission sequence,
`ChatOperations.send`: within the budget, under the chat's lock (`KeyedLock`), the chat open, its **receipt** recorded
in `app_chat_operations` with the selected Pi session, a routine's waiting question answered, the session on the
owner's model, then Pi's submit (or the subagent relay), the receipt moved on to `submitted` (or `refused` with the
failure's type), and one flow event. A Persona ask takes the same admission (`ChatOperations.admit`). A retry uses the
recorded session; the receipt alone proves no Pi acceptance, so a retry still submits the same operation for Pi to
deduplicate. A receipt (`chats/receipts.ts`) says what the operation was (`kind`: send, ask_client, telegram,
persona_ask, start, reply, empty, move, `write:<entry kind>` for a passive write…), who started it (`origin`), the
chat it made (`target_chat`), the operation that led to it (`parent_op`), how it ended (`state`, `reason`,
`settled_at`); one admitted before receipts had kinds reads as `legacy`, and `receiptOf` reads one synchronously by
operation id. Passive writes (`ChatOperations.passiveWrite`: thread heads, shares, announcements, routine reports,
Persona answers, memory views) write their receipt and Pi's write under the same lock. Rows older than 30 days are
pruned opportunistically. The lock covers admission only, and releases before model execution or waiting for an
answer. Nothing rebinds a chat: Move to thread (ADR 0034) forks the moved turn's Thread and records a `move` receipt;
Topics and their memory are below.

**Setup and scope** (`setup/`): each chat works with its Topic's setup ([ADR 0040](adr/0040-topic-and-persona-setup.md)).
`sessionScope(db, session)` (`setup/scope.ts`) maps the calling Pi session through `chatOf` to its current chat; `chatScope(db, chat)`
reads, live, the setup of the Topic at the top of its chain (a chat's `topic_id`), joined in a Persona's fork with the
Persona's, and narrows it for a subagent by the exclusions of every spawner above it (`subagent_config`, ADR 0018;
`app_conversation_capabilities` and `app_execution_exclusions` hold them), at any depth, then by a routine run's
allowed tools (an unknown or no-longer-owned session, a chat whose Topic is gone, or a broken or cyclic chain of
spawners, may use nothing). The scope also answers for agent apps (`app`) and names its Topic, so a refusal can say
what held it back. What the scope leaves out is hidden from the model: `mcp_list` leaves it out, the `skills` section
does not list or fetch that library, and Pi's per-conversation tool filter (`configure({ tools: { remove } })`) drops
the subagent tools, whose section then hides too; Pi stores the filter as tool names, so when those names changed
every filtering conversation's filter was applied again once (`retoolOnce`, which skips Persona forks and routine
runs, whose filters are set when they are made). A call that still arrives runs nothing: `mcp_call`, `skill_activate`,
`skill_read`, `subagent_spawn` and `subagent_send` check the scope before anything else (before the grant check or any
connection) and return an error result (`pi/setup.ts`, `outsideScopeResult`): when the Topic's setup does not hold the target,
details `{ kind: 'not-in-topic', target, topic }` (`NotInTopic`) that ask the owner to add it to the Topic, and Goblin
waits; in a subagent, a Persona or a routine the result has words only. The ask shows in the chat's `attention`. The
owner's console and an App view and job calls carry no conversation. Agent-initiated app calls carry their
conversation through nested apps and MCP powers, so its scope is checked live at dispatch; Telegram and inbound clients
talk in Personal's Conversation, so Personal's setup covers them.

The per-conversation switches of ADR 0010 are gone. The agent's start (`RetoolLive`) deleted the owner's rows once
(`dropSwitchesOnce`, marker `drop:conversation-switches`), keeping every subagent's, applied the Pi filter again to each
chat that had subagents switched off, and logged the count as a `job` line (`conversation-switches-dropped`).

The persona contributes two static system-prompt sections (`pi/persona.ts`): who the agent is, and that remote content
is untrusted data. The system prompt holds only text that does not change between requests: pi-ai folds every change
of it into the one leading system message, which empties the provider's prompt cache. What does change (the apps with
their versions, members and last errors; the skills on offer) goes into one trailing `<goblin-context>` message that
`beforeRequest` hooks add to each request (`pi/context-tail.ts`), marked as goblin's note and not the owner's. Pi
never stores it, so everything before it stays a cacheable prefix. The `mcp_list` and `mcp_call` tools
(`pi/resident-mcp.ts`) are how the model reaches the owner's MCP servers; both require current resident authority, and
`mcp_call` is marked unsafe to replay. `mcp_list` lists the connections with the owner's labels (two accounts of one
server are told apart by them; ADR 0041), and shows each tool's input and output schema (the server's, untrusted
data). Refusals, held calls and the `skills` section name a connection the same way, `"<label>" (<connectionId>)`
(`named` in `mcp/labels.ts`); labels never enter telemetry. `mcp_call` takes its `arguments` as an object or the JSON string of one, and returns the server's result as
Pi's MCP tools shape it (content blocks, `details.structuredContent`, `_meta` and the origin).
Remote result details and signed routine event metadata share `mcp/redaction.ts`: it scrubs exact credential-shaped
keys such as `accessToken`, `refresh_token` and `apiKey`, recursively. Public asset and usage fields such as
`rewardToken`, `token`, `tokens` and `tokenAddress` remain readable.

`ask_user` (`pi/ask-user.ts`) is how the agent asks the owner something. It takes one to five short questions:
single choice, multiple choice or free text. The tool result is the questions as numbered plain text, with details
`{ kind: 'question', questions }` (the `QuestionSpec` contract). It ends the run with `control: { terminate: true }`,
so no model call waits on a person. The answer is the owner's next ordinary message, whether it comes from the web
card or any other channel. A question counts as settled once a later user message exists.

The browser URL, snapshot, history and queue use chat ids. Server-Sent Events resolve the current Pi session at
connection: a snapshot of committed Pi entries, then batches, with a heartbeat. A chat keeps its Pi session, so its
stream is that session's; a reconnect starts again from a fresh snapshot. The workspace feed maps Pi task activity back
to current chat ownership. `ConversationView.primary` is an optional boolean; `WorkspaceSnapshot.primary` is an optional
chat id for compatible readers.

Every signed-in page sits beside the app's shell (`components/shell`, ADR 0036): a moss rail of places (Home,
Threads, Activity and Tasks, each with a count of what waits there, and at its foot Apps, Connections, Settings and
Sign out) and the sidebar of channels, both always shown on a desktop; on a
phone they share a drawer from the left edge (`DrawerSide` in `@goblin/ui`, `tone="shell"`) that the page's top bar
opens and a swipe left closes. The rail's pages (`components/shell/pages`, over the pure `lib/rail.ts`): Threads lists every thread, unread first, the
closed folded; Activity collects what needs the owner across Topics (each chat's `attention` from a server that
reports it, and agent apps whose schedules need the owner), the unread chats, and organizing receipts with Undo
(`POST /api/organize/:id/undo`, offered while the receipt is undoable); Tasks lists the Delegates (subagents) at work
and finished, the Personas answering and answered, and the routines on a schedule. On a server with Personas the
sidebar lists them after the Topics; a click opens the profile (`/p/<id>`), never a chat: its definition (a glyph on
a hue, name, role, instructions, a model from the offered ones, and what it may use, which only narrows the owner's
grants) saved as a new revision with the revision it was read at (`PATCH /api/personas/:id`, a conflict asks for a
reload), Archive or Restore, and its revisions. `/p/new` creates one (one operation id per visit). Connections and Settings are columns of titled sections (`PageSection`)
whose states read in words (`lib/labels.ts`), never the raw value the runtime sends. The workspace fills the page beside it. The transcript scrolls in a `MessageScroller` (from `@shadcn/react`, patched with upstream fixes that are not
released yet; `bun run check:patches` proves the patch is installed). Each of
the owner's turns (typed in the app or sent from Telegram, `isOwnTurn` in `lib/parts.ts`) is a scroll anchor; a
message from an MCP client, a subagent, a routine or a thread's share-back arrives without moving the view. Until its
snapshot arrives a chat shows nothing. Conversations open at their end. A turn map in the transcript's right gutter
(`components/turn-map.tsx`) marks each of the owner's turns where it sits, with a band for what is on screen; hovering it
lists the turns and a click jumps to one. Without a fine pointer, or in a narrow window, an edge tab opens the list as a
bottom drawer that a swipe down closes. A new turn of the owner's pins near the top while its reply fits beneath it; once the turn is answered
past the fold, whether the reply grew there or arrived with it (a snapshot after the tab was away, a Telegram turn),
the view follows the bottom. It follows a streaming reply only while the reader is at the end, and otherwise offers a
jump back. A message just sent shows at once, before the stream confirms it (`lib/echo.ts`; the server's entry takes
its row), and a `Thinking…` row stands in after it and after every tool result until the model's thinking, answer or
next tool arrives, because a model's first content can take tens of seconds. A turn's thinking and tool calls fold into one
line each (`lib/work-groups.ts`): while it runs it names the step, settled it counts them, and it opens to the rows,
with calls in a row to one MCP server merged. A failed call, a request to the owner, a subagent, an App build and a
call whose App is open stay in the flow. The chat's bar and the composer float over the transcript as translucent chrome. Assistant Markdown is parsed by Streamdown (`components/parts/markdown.tsx`) and set by shadcn/typeset, whose append-stable rules keep earlier blocks still
while a reply streams. Streamdown splits a reply into blocks and renders each on its own, so a streamed batch renders
only the block being written; it stays in streaming mode once the reply settles, so the blocks are not remounted. Every
Streamdown renderer is replaced by its plain element. A reply may use a little HTML (`lib/reply-html.ts`: line breaks,
folds, keys, sub/superscripts, marks and edits, with no styles, handlers, frames or scripts), and its links and images
keep only absolute web addresses (and mail or footnotes for links); everything else becomes text
([ADR 0039](adr/0039-chat-markdown-through-streamdown.md)). A code block is Goblin's own (`CodeBlock`): typeset's
code with a copy button, coloured by Shiki for the theme once the first code block loads it in the browser; Shiki and
its grammars never reach the first load or the Worker. A table in a reply (`ReplyTable`) scrolls sideways and has a
corner menu to copy it as Markdown, CSV or TSV, or download it as CSV, read from what is on screen. Math between `$$`
marks sets in KaTeX, loaded with its stylesheet the first time a reply holds `$$`; a single `$` stays a dollar sign.
While a reply streams, a caret follows its last paragraph, heading or list item, and its words fade in over 150 ms
(Streamdown's `animated`); with less motion asked for, they just appear. An image in a reply is a button naming it and its host; it is fetched only when the owner asks,
without a referrer, so a reply cannot make the browser call an address by itself (a prompt-injected image URL would
otherwise carry data out). A link stays a real link, but in the shell a click or middle click opens one shared dialog
(`LinkConfirmProvider`) showing the whole address and its host first, since a reply can name one place and point at
another; it then opens in a new tab without a referrer or opener.

Tool calls remain quiet expandable lines (`ToolCall` in `packages/ui`). Opening one shows labelled Input and Output
sections (`ToolPayload`), with the local `JsonView` adapted from MIT-licensed `mnove/json-view-cn`. The root opens,
nested branches fold, long strings expand on request, and each object or array shows 50 children at a time. The web
selector (`lib/tool-payload.ts`) reads the existing redacted MCP envelope: structured output first, then individual
content blocks, suppressing a duplicate JSON text block while keeping additional prose and non-text blocks as data.
Text that reads as Markdown opens Formatted (`lib/markdown.ts`), judged by the CommonMark and GFM grammar the renderer
parses: a table, two kinds of anchor (an ATX heading on its own line, a fenced code block, a table), or one anchor
among three kinds of signal. YAML and script comments, diffs, tracebacks and listings stay plain, because a missed
document is still readable and a false one would mangle data. `ToolMarkdown` sets it, through Streamdown's static mode, in the compact `typeset-tool`
preset as untrusted text: images are named and never loaded, only absolute http(s) and mailto links work and they
show their host, raw HTML shows as written and fences stay code. Reference definitions and link titles show only in
Raw. A long payload scrolls in place and fades at its bottom edge while more lies below (`scroll-edge-bottom`, driven
by its own scroll position). Ordinary or incomplete result text stays readable. Raw and its Copy action preserve the complete original text;
the tree copies complete values rather than its shortened display. No renderer fetches URLs or changes authority.

When the agent waits on the owner, the request is pinned above the composer until their next message
(`lib/interactions.ts`). This covers `ask_user` questions (a questionnaire) and grant-required results (an Allow card
for the exact server and tool). The reply is an ordinary message with a stable operation ID: `answer:<callId>` or
`grant:<callId>`. Allow first sets the exact grant through `PUT /api/mcp/grants`, and the allowed tool stays allowed.
In the transcript, both requests leave a quiet receipt. An Allow card is only trusted from goblin's own result for
the tool that was called, never from a remote result, which always carries `origin`.

At a keyboard and mouse Enter sends and Shift+Enter breaks the line; on a touch screen Return breaks the line and
the Send button sends, with ⌘/Ctrl+Enter from a hardware keyboard (`lib/keys.ts`). The composer carries the agent's presence (`lib/presence.ts`): one state for the whole agent, with the most urgent
first. In order: offline, waiting for the owner, retrying, using a tool (named `server · tool`), writing, thinking,
budget spent, no answer, and ready. A small orb of moving colour (a Paper Shaders `MeshGradient`, loaded lazily)
shows it beside a text label, and its pace follows the work. While the agent waits on the owner, a pulsing border
frames the composer. Under reduced motion, in a hidden tab, before the shader loads, and in a channel while the thread
panel is open over it, the orb is a still gradient (no WebGL context of its own), and
the border is absent. Colours come from the theme's `--presence-*` tokens, resolved to RGB at runtime.

## Outbound MCP

Connections come from `GOBLIN_MCP_SERVERS` (JSON: `connectionId`, `endpoint`, optional `label`, `issuer` and
`resource`) and from the owner, who may add up to thirty-two by URL (`app_mcp_connections`, ADR 0006). A server is an
address and a connection the owner's account on it (ADR 0041): the owner may connect one server several times, each
connection with its own id, sign-in, grants, skills switch and Events. Every connection has the owner's **label**
(`app_mcp_labels`, `mcp/labels.ts`), one line of at most eighty characters, unique whatever its case: given when it is
added (`AddServer.label`), else the first free name from its server card's title (`Example`, `Example 2`), or the
configured `label` (else its id) for a configured one, set once at start; `PATCH /api/mcp/:id` renames it. A
connection registers with its authorization server as `goblin · <label>`, so the consent screen names it; MCP has no
standard "who am I", so goblin cannot show which account a sign-in reached. An added endpoint is a public https address
(`mcp/endpoint.ts`), and its server card's title, description and icon are the server's own claims, for the owner's
eyes only. Configured connections win on ID and cannot be removed. Removing an added connection forgets its row,
label, endpoint binding, credentials, pending sign-ins and grants in one transaction. Connections also offers a shelf of suggested servers (`mcp/suggested.ts`), with source
comments recording their connection checks. One tap adds and connects. It also searches MCP registries that speak
the generic registry API (`mcp/registry.ts`, `GET /api/mcp/catalog?q=`): the Official MCP Registry and GitHub's, built
in, then up to eight the owner adds (`app_mcp_registries`). A registry is
added only once it answers `/v0.1/servers`, and removing it keeps the servers added from it. Search reads one page of
up to twenty entries per registry and keeps https streamable-HTTP remotes, rejecting entries explicitly marked
inactive or not latest. Missing status metadata is accepted. Results are labelled by registry, each server once
(the official registry first), and cached for ten minutes. Each registry gets eight seconds (`Effect.timeout`). A
registry that is not reached fails as `UpstreamMcp` transport and one that answers anything but the registry API as
`not_a_registry`; in a search either is logged and leaves the answer partial and uncached (`mcp_suggest` says so, and
`GET /api/mcp/catalog` answers `{ entries, partial }`, which Connections shows). The catalog lives in the `McpServers`
layer (`layers/mcp.ts`), not the host.
Endpoint placeholders are filled with one safe path
segment each, and servers that require a secret header are listed but cannot be added yet. An added entry records
its registry, name and version. The owner connects each server from the Connections page:

1. `POST /api/mcp/:id/connect` first tries without sign-in. If needed, it runs the MCP SDK's `auth()` with our
   `StoredOAuthProvider`: discovery, dynamic client registration, PKCE. Only a flow needing consent returns a remote
   authorization URL; otherwise it returns `{}`. A server the open try cannot reach answers that transport failure;
   no sign-in starts for it.
2. The remote server redirects to `/api/mcp/oauth/callback`. The pending state is single-use and expires after ten
   minutes; the code is exchanged and the tokens stored.
3. Client registration and tokens are AES-GCM encrypted at rest (`GOBLIN_CREDENTIAL_KEY`, bound to server ID and
   purpose); discovery metadata is stored in plain JSON.

Credentials and grants belong to the endpoint they were made for (`mcp/endpoints.ts`, `app_mcp_endpoints`). When the
agent starts and a server ID now points at another endpoint, everything stored for it is dropped in one short
transaction: credentials, client registration, pending authorizations and grants. The owner connects and grants
again, so tokens issued by one host never reach another.

Calls go through the connection manager (`McpConnections`, `mcp/manager.ts`), keyed by server ID, which caches a
connection and closes it after five minutes idle. Its auth provider (`mcp/auth.ts`) refreshes a token a minute before
expiry, one `SingleFlight` per server, and refreshes once after a 401. A refresh the authorization server refuses (an
OAuth error, a refused flow, a 401) marks the server `needs_auth` and the owner reconnects; one that never got an answer (the network, a 5xx) fails as `UpstreamMcp`
transport and keeps the credentials for the next call (`mcp/errors.ts` `isOAuthRejection`). Results are bounded (1 MiB,
16 MiB for App HTML); a result JSON cannot hold is `unsupported`, not over the limit.

Grants are per discovered tool (`app_mcp_grants`), toggled by the owner. A tool grant also grants its `ui://` App
resource. An App's switch (`PUT /api/mcp/app-grants`, `McpGrants.setApp`) grants an App as a whole: exactly the
tools that declare its `ui://` resource, including the ones only the App may call, and the resource itself.
Connections (`components/tool-grants.tsx`) lists those tools under the switch, each still adjustable, and offers Allow
all and None, which send the same exact grants one at a time. Tool annotations from the server are shown as its claims
("says read-only") but never grant anything. Disconnecting forgets credentials and keeps grants. When the model calls a tool that exists but is
not granted, nothing runs. `mcp_call` returns an error result whose details are
`{ kind: 'grant-required', connectionId, name }`, and the model is told to wait.
`mcpModelResult` details never carry a top-level `kind`, so remote content cannot forge one. The web turns that
result into an owner-only Allow card. A Topic's setup chooses servers and tools for its chats (Setup and scope, above);
that check comes first, and a helper's exclusions are forgotten with the server's grants.

## Skills

Skills come from MCP servers that declare the MCP Skills extension, and only from those the owner turns them on for
in Connections (`app_skill_sources`, ADR 0008). The client declares the extension; `McpConnections.skills` and
`skillFile` speak `skills/list` and `resources/read`, with the shapes decoded in `skills/protocol.ts` because the SDK
has no Skills support yet. The library activates entries from `skills/list`.

The `Skills` service (`skills/library.ts`) keeps each enabled server's listing for its `ttlMs` (30 s to an hour) and names
every skill `<server>:<name>`. The `goblin.skills` extension (main, threads and helpers) renders that list in
its `skills` section, refreshing an expired listing when the section is evaluated, and offers `skill_activate` and
`skill_read`. Activation reads `SKILL.md`, checks size, SHA-256 and frontmatter against the entry (`skills/verify.ts`),
and records the entry for the conversation (`app_skill_activations`). `skill_read` reads only files in that retained
manifest, so a conversation
stays on the version it activated. Verified bytes are cached by digest (`app_skill_files`) and checked again on every
read. A corrupted cache row is rejected and repaired by a verified refetch (local workerd regression evidence). A
local workerd restart preserves the activation manifest and cached bytes, then reads the same version without a network
call.
An unreachable server keeps its last listing while it remains cached in the isolate, or is reported unavailable.
Dynamic skills are declined; skill scripts can be read but are never executed (the only code goblin runs for the agent
is its own apps' and `code_run`'s, in Dynamic Workers; see Agent apps). Enabled skills are procedures the agent
follows, but they grant no permissions and cannot override the owner. Disabling the server stops new activations and
file reads; instructions already in a conversation stay there. A Topic's setup can leave a library out (Setup and
scope): its chats' section leaves it out without fetching it, and their activations and reads are refused. A setup
can also hold single skills, by server and name (a new version keeps its place; a URI is kept only to tell namesakes
apart): the section lists only those, the composer offers only those, and `skill_activate`, a composer selection and
`skill_read` ask the scope about the one skill (`skillScope`'s `(connectionId, { name, uri })`) before anything is loaded or
read, a cached file included. A skill outside the setup refuses with the `not-in-topic` ask.

After a final answer in an owner conversation (`goblin.skill-learning`, `onYield`), the learner (`skills/learner.ts`) looks at the latest user message. On a correction
or a request to keep how something was done, the memory model decides whether the exchange teaches a procedure. A
procedure becomes a draft sent through an enabled library's granted `skill_draft` tool, which the owner reviews in the
library. The Worker logs the learner outcome and conversation id without transcript or draft content. At most five in a rolling 24 hours, never the same content twice, no new draft while one for that skill is open,
and never a rejected draft again (`app_skill_drafts`). A grant for `skill_draft_status` lets the learner refresh review
status; a deterministic workerd test confirms a rejected draft is not submitted again for the same lesson. Draft
payloads contain generated procedure text and brief evidence, with email- and secret-shaped strings
scrubbed, and no transcript field. The learner's model call counts toward the budget.

## Chat blocks

The agent's replies draw fenced blocks (ADR 0023): ```mermaid diagrams, and ```chart and ```map with a
JSON spec (`ChartSpec`, `MapSpec` in `packages/kit/src/specs.ts`). `MessageText`
(`components/parts/text-part.tsx`) hands such a block to `RichBlock` (`components/parts/blocks.tsx`), which loads that kind's module from `@goblin/kit`
on first use and shows the plain code block whenever the source does not parse or drawing fails. While a reply
streams, the block whose fence is still open stays code: Streamdown parses each block on its own and says which one
that is (`useIsCodeFenceIncomplete`). A diagram is beautiful-mermaid's SVG as an
`<img>` data URI with the theme's tokens resolved to concrete colours, so nothing in it runs or loads; it redraws when
the theme changes. **Explore diagram** opens the kit's native dialog with Panzoom 4.6.2, fitted 1–4× zoom,
bounded dragging/pinch gestures and keyboard node selection. `diagram-svg.ts` rebuilds a passive, allowlisted SVG,
scopes the renderer CSS and namespaces marker IDs; model callbacks, links, font imports and external paint URLs
are discarded before inline insertion. `Diagram` defaults to interactive; `interactive={false}` keeps only the image.
The dialog stays inside an agent app's frame. Charts are Recharts in the five `--chart-*` tokens; maps are Leaflet over
OpenStreetMap's raster tiles, quieted to the theme by a CSS filter, the one host a block fetches from. The persona prefers ordinary Markdown and describes the supported fence grammars; Telegram shows drawn fences as code.

## MCP Apps host

An App is a tool's `ui://` resource, served by the server that answered the call. It runs in two nested opaque
sandboxed frames (`lib/app-sandbox.ts`). The outer proxy only relays protocol messages to and from the host's origin.
Its calls go through the owner API to the originating server and need that server's grant.

The app is a Slack-style shell (ADR 0036, `components/shell`): the rail and the sidebar, then the channel, with the
thread panel placed by the channel's own width (a container query): beside it where the channel can spare the panel,
over its right side where it cannot, over all of it (with a crumb back) where the rest would be too narrow to read, and
as a full view of its own on a phone. The
channel and the panel are fixed to the viewport beside the navigation, so the composer's keyboard handling holds; each
draws its own bar (the channel's `#name`, the panel's back crumb, title, menu and ×) as translucent chrome over its
transcript. Apps and composers reach the shell only through `lib/navigation.ts`, which `components/shell/navigation.tsx`
implements over the router.

Apps are kept (ADR 0020). A call the owner's agent makes to a tool that declares an App keeps it in the agent's
registry (`apps/registry.ts`, `app_registry`, one per Pi session and call); `chat_id` names its placement while the
original Pi session and call id still own the arguments and results. *Show app* on an older or closed one keeps it
through `POST /api/apps`. The workspace feed lists them (an App's name is numbered when one title repeats in its
conversation, `lib/app-names.ts`), and closing a conversation closes its Apps. `GET /api/apps/:id/launch` reads the call's arguments and redacted result back from the
transcript; keeping and launching grant nothing.

Several Apps run at once, in any conversation the owner views (`components/apps`). `AppHost` holds one instance per
loaded App, and `AppLayer` draws one fixed stage per instance outside the chats, never moved in the DOM, so nothing
reparents an opaque frame or replaces its bridge. A stage follows its App's page, then its place
under its tool row (`app-page:<id>`, `app-inline:<id>` slots), frame by frame, including while chats scroll, and
springs between these places (`lib/spring.ts`). It clips itself to the containers that scroll its slot, to its chat's
bar and composer (`data-app-cover` inside the chat's `data-app-scope`) and to the thread panel lying over a channel
(`data-app-overlay`, `lib/app-occlusion.ts`), which also keeps pointer events off what is hidden; text fades out under the same chrome through a mask on the transcript. An App
loads when its place comes on screen; beyond six instances the least recently seen unloads to a stub
(`lib/app-residency.ts`), while one on screen never does. The advertised modes are inline and fullscreen: fullscreen is
the App's page, `/a/<id>`, the main column under a bar with "Back to #channel". In its transcript the host's bar above
an App opens its page or closes it; on its page the bar's menu brings it back in the conversation or closes it. Agent apps are listed in the sidebar's
Apps section and on the Apps page (`/apps`, `/apps/<name>`: `components/apps-page.tsx`, `components/app-manage.tsx`). Grant cards, link offers and context sharing remain
host-drawn, per App.

The App learns the host context (`lib/host-context.ts`): theme, our tokens as MCP Apps style variables, device,
locale and time zone, its display mode, surface, the modes on offer, and its measured box. The host re-sends it when these change.
On its page the App fills the main column; in its transcript its own height request is bounded (160px to 70% of the
window).

Two more requests are drawn by the host, where the App cannot reach (`lib/app-context.ts`). A link the App asks to
open (https only, no credentials) becomes an offer with a real anchor, so only the owner's click opens it. Context
the App shares for the agent (`ui/update-model-context`, text or structured content rendered as JSON, at most 8192
JavaScript string units) waits in a removable chip above its conversation's composer and travels once, with the
owner's next message there, as `appContext` (`{ app: <App id>, text }`) on `POST /api/conversations/:id/messages`. The
runtime reads where each open App comes from in its registry, never from the browser, and (`pi/content.ts`) appends the
text after the owner's words as a separate block shaped `{ origin: { connectionId | app, trust: 'untrusted' }, appContext }`
(an MCP App's server, or the agent app's name). An agent app's view shares through `share(text)` in its SDK. The persona
treats it as data, never as the owner speaking, and the transcript shows it as a note under their message.

An App's own call to a tool the owner has not granted does not fail at once (`components/apps/grant-ask.tsx`). It
waits on a card the host draws in the App's chrome, naming the exact tool. Allow grants that one tool and runs the
same call again. "Not now", or two minutes without an answer, returns the denial to the App.

## Agent apps

The agent builds apps for the owner (ADR 0021): small programs with durable JSON state whose actions and views it
calls with `app_call`. `app_build` takes an app's files (`app.ts`, up to five more, TypeScript, importing only `@goblin/app` and
each other); `agent-apps/build.ts` transpiles them with sucrase in the toolchain's own Dynamic Worker, runs the
release's `describe()` in the release's isolate, checks the manifest (`agent-apps/manifest.ts`: names, schemas of the
`s.*` subset, `initial` fitting `state.schema`), and on an upgrade keeps the state when it fits the new schema or
runs `state.migrate`. Only then does the release become active, as one transaction (`agent-apps/store.ts`); a failed
build is kept with its problems and changes nothing that runs. Every app release, the transpiler and `code_run` run
through `agent-apps/isolates.ts` over the `LOADER` binding: no network, no bindings, a CPU limit, at most eight calls
at once, and wall timeouts.

A call (`agent-apps/dispatch.ts`) checks its input against the member's schema; an action's `prepare` runs once
with a read-only state snapshot and the app's powers (its own files in Shell's namespace `app_<name>`, a log line),
then, holding the app's lock (the agent runtime's `KeyedLock`, one key per app, first come first served), `run` reads
the current state and returns the next, which is checked and committed as one revision with the operation's receipt.
The owner's paths hold that lock in the runtime (`agent-apps/live.ts`); Pi's tools, job alarms and an isolate's calls
take the same lock through the bridge's `local`. A replayed operation id returns its receipt. The agent calls every app through
one typed tool, `app_call(app, member, input)` (`agent-apps/toolset.ts`, ADR 0027), so the tool list stays the same
whatever apps exist and a build leaves the prompt the provider caches alone; an action the app keeps for its view is
refused, and a state or value over 8 KB comes back as a valid summary (its size and fields). The `<apps>` part of the
trailing context block lists each app's members with their typed inputs. A call pins the release it began on
(`goblin.release` memo) and refuses to run on newer code. Subagents and routine runs set their own exact extension
lists and get no `app_call`. `goblin.apps` (`pi/apps.ts`) offers `app_docs`, `app_build`, `app_inspect`,
`app_rollback` and `code_run`. The SDK, release entry, transpiler and
docs are `packages/app`, built into `dist/toolchain.js` (loaded only while building).

An app with a `view.tsx` has a UI (`packages/app/docs/ui.md`). The transpiler makes the view one CommonJS module with
React's automatic JSX runtime and refuses imports the frame does not provide; the style compiler (Tailwind's, with
goblin's theme, in its own Dynamic Worker) compiles exactly the classes the view uses. Both are kept per release
(`app_agent_views`). Before a release activates, the render check (`packages/app/src/render.ts`, a Dynamic Worker
with the view as its CommonJS module and a shim for each import) renders the view once with the state the release
starts with, goblin's components for real, and charts, maps, diagrams and
icons as stand-ins. A view that throws fails the build with its line of `view.tsx` and changes nothing that runs;
one that reads a browser-only global while rendering, or a check that did not run, activates with `viewWarning`.
The first release with a view adds the app to the App
registry under its home conversation
(`apps/registry.ts`), and every revision after that reaches the workspace feed. The web host loads it like an MCP App,
in the same double sandbox (`lib/app-sandbox.ts`): a document of goblin's stylesheets, the app's own, and its module,
over the frame bundles from `packages/app/dist/runtime` (React, the UI SDK and goblin's components in `core.js`;
charts, maps, diagrams and icons only when the view imports them), served as hashed assets. The frame has no network
(`connect-src 'none'`); it loads scripts from goblin's origin only, and tiles from OpenStreetMap only for maps. The
bridge (`lib/agent-app-bridge.ts`) sends the state as tool results carrying `goblin/state` (the newest revision wins),
routes the view's action calls to `POST /api/apps/:id/call` with the frame's operation id (the agent keeps it as
`ui:<app>:<uuid>`), and reports the view's failures, which the agent sees in its `<apps>` list and in `app_inspect`.
The frame (`components/apps/frame.tsx`) makes those calls through the factories in `apps/queries.ts`, which also carry
an MCP App's own tool calls and resource reads to its server with `x-mcp-caller: app`. The frame's first script
keeps errors from before the core runs (a bundle that throws as it loads or never arrives), a view import whose bundle
failed names that bundle, a view module that throws shows the error card instead of a blank frame, and failures that
come together go out as one notice once the frame is connected (`packages/app/src/ui/core.ts`, `sdk.ts`). A bundle's
own message reads "Script error." because the frame is a different origin from the bundles. A new release reloads the
frame; a new revision is pushed into it. In the transcript the view shows under the newest build of it with one.
Inline agent app views have a borderless host surface and a quiet toolbar for page and close controls; the view
owns its canvas styling. External MCP Apps retain their framed host surface.

Beyond its state and files, an app reaches only the powers it declares and the owner approves (ADR 0021):
`ctx.fetch` to exact `egress` hosts (`agent-apps/egress.ts`: https on 443, never goblin's own domain, redirects checked
again, no cookies, bounded), and through the agent (`agent-apps/ports.ts`, lent by `agent.ts` with the engine, each call entering it
through the bridge's `run`) the owner's MCP
tools under their exact grants, the cheap model within the owner's budget, Telegram through their channel, and other
apps' actions and views (`agent-apps/reach.ts` composes each `prepare`'s `AppPowers`). Every use checks the approval
(`app_agent_powers`), the app's daily cap (`app_agent_usage`) and, for what goes through the agent, the owner's plan
and resident authority. A build lists the powers still waiting; the web draws them as a card under it
(`components/parts/app-powers.tsx`). A view offers files to save through the host's download offer. The agent looks
for MCP servers with `mcp_suggest` and asks the owner to add one with `mcp_request_server` (`pi/servers.ts`), a card
whose Add and connect runs the usual flow.

An app's `schedules` run its actions on their own (`agent-apps/jobs.ts`): one `app_agent_jobs` row and one dated
native schedule (`runAppJob`) per scheduled action, reconciled when a release activates or rolls back and when the
agent object starts. A job is an ordinary call with its own operation id; it catches up only the newest missed slot,
backs off after failures and pauses after ten, and waits while resident authority lapses. Each app's schedules ride
the workspace feed (`AgentAppSource.jobs`) to the App's bar.

## Files

The owner's files (ADR 0022, `files/store.ts`): `@cloudflare/shell`'s Workspace over the agent's SQLite, with files
over 128 KiB in the stage's R2 bucket under `agents/<userId>/`. `/uploads` holds what the owner uploaded; `/agent` is
where the agent writes. The owner reads and writes both through `/api/files`; the agent reads both and writes only
`/agent`, with `files_list`, `files_read` (text, 48 KB a page), `files_write` and `files_delete` (`pi/files.ts`, the
`goblin.files` extension, on main and threads; subagents and routine runs keep the tools they are handed). Limits: 25 MiB a file, 512 MiB and 2,000 files in all, checked before
each write; a body longer than it declared stores nothing. The composer's paperclip uploads to
`/uploads/<local date>/` under a name that replaces nothing (`lib/files.ts`), and the message carries the paths: Pi
gets the owner's words, then one block listing each file's path, name, size and type, then any App context
(`pi/content.ts`). The web reads that block back into chips under the message (`lib/app-context.ts`), only when every
block after the words is one it knows. Deleting the account deletes the R2 prefix before the object's storage.

## Topics

A Topic ([ADR 0032](adr/0032-topics-and-per-topic-memory.md)) is a channel with exactly one Conversation and any
number of threads. `app_topics` holds them (`storage/topics.ts`); Personal is Topic 1, seeded by the additive
`20261026000000_topics` migration with Main (chat `1`) as its Conversation, and `app_conversations.topic_id` (default
1) puts every chat in one. `role` is `primary` for Personal's Conversation, `conversation` for another Topic's; both
keep `kind = 'main'`. `Chats` answers `isConversation`, `topicOf`, `conversationOf(topic)` and
`conversationAbove(chat)` (functions of the database in `chats/directory.ts`); `primary` stays Personal's
Conversation, where Telegram and inbound MCP clients land.

Each Topic has a **setup** ([ADR 0040](adr/0040-topic-and-persona-setup.md)): its MCP servers, skills and agent apps,
each `all` or a list, and whether its chats may start subagents (`TopicSetup`, `packages/contracts/src/setup.ts`).
`app_topics.setup` stores it as JSON; the additive `20261028000000_topic_setup` migration gave every existing Topic,
Personal included, everything. A row that cannot be decoded reads as nothing chosen (`topics/setup.ts`), never as
everything. `editTopicSetup` (`topics/program.ts`) changes it as one new revision: a whole setup compare-and-set, or
items added or removed (`withItems`/`withoutItems`; removing from a category that holds everything lists what
`setupCatalog`, `setup/catalog.ts`, says the owner allows now). The agent may add only what the owner allows now; the
owner may keep or restore an item that is gone, which stays listed. A real change leaves a `topic.setup` receipt whose
Undo restores the setup before it, applies the Pi filter again to the Topic's chats when subagents changed
(`retoolTopic`), and answers the routines it leaves without some of their allowed tools (`routinesOutside`). The
`<apps>` context lists only the apps a chat's scope holds, and a new agent app built in a Topic that lists its apps
joins that Topic's setup with an agent receipt (`newAppJoinsTopic`; a failure there leaves the build as it is).

`TopicRegistry` (`topics/registry.ts`, a store behind the `Topics` service in `topics/service.ts`) creates a Topic
with a new Pi session as its Conversation, not forked from Personal's: its tool filter follows its setup's subagents,
and nothing is copied from Personal. Create is idempotent by operation id and serialized by the service's `KeyedLock` (key
`topics.create`), so a retry or concurrent repeat finds one Topic and one Pi session; active
names are unique ignoring case (409). A Topic's Conversation is never renamed or closed directly and takes its Topic's
name. Branches, "+" threads (`CreateConversation.topic`) and subagents inherit their parent's Topic, and a "+" thread
announces itself in its Topic's Conversation. Archiving (`topics/program.ts`) marks the Topic and then stops each open
chat's work through the owner's Stop (runs, queued inputs, subagents and routine runs); its chats refuse new work
(`topic_archived`) until Restore, which restarts nothing. Personal is never archived. Schedules are untouched.

| Route | Purpose |
| --- | --- |
| `POST /api/topics` | `CreateTopic` (`{ name, operationId, setup? }`): a new Topic and Conversation, with that setup or everything, or the one that operation made; 201. |
| `PATCH /api/topics/:id` | `UpdateTopic`: rename, archive or restore, and the automatic-search opt-out; one new revision per change. |
| `PATCH /api/topics/:id/setup` | `TopicSetupEdit`: a whole setup (409 unless `expectedRevision` is current) or items added or removed; answers `TopicSetupSaved`, the Topic and the routines it leaves without some of their tools. |
| `GET /api/setup/catalog` | `SetupCatalog`: the servers with the tools the owner granted the model, the skill servers they turned on with the skills each lists, and the agent's apps. |

They are the owner API's `topics` group (`topics/api.ts`); the web reads the Topics, archived ones included, from the
workspace feed. Its snapshot lists `topics`, a change is
`{ type: 'topic', topic }`, and each `ConversationView` carries `topic` and, for a Conversation, `conversation: true`.
Its `attention` (`attention.ts`) lists what in that chat waits on the owner for the Activity rail: the asks since its
newest user message from goblin's own tool-result markers (`ask_user`, a grant request, something outside the Topic's
setup), its
pending held MCP calls, and the unanswered powers of agent apps living there.
Unit tests run the real migrations in `node:sqlite`; the local workerd owner case `topics-case.ts` runs in both
native profiles. Neither is deployed-stage evidence.

## Personas, organize receipts

A Persona ([ADR 0033](adr/0033-personas.md)) is a named, versioned agent definition the owner tags with `@name`. The
registry (`personas/registry.ts`, `Personas`) keeps `app_personas` and every revision in `app_persona_revisions`;
updates are compare-and-set on `expectedRevision`. A send with Persona selections (`submitOwner`, `personas/ask.ts`)
admits the operation, records one `app_persona_invocations` row per Persona, writes a passive `app.persona_ask` entry
(no Goblin run starts) and creates one background `goblin.persona-turn` task per Persona, guarded by an
`app.persona-asks` document. A turn (`pi/persona-turn.ts`) forks the chat at the ask entry (in a sequence, at the
previous Persona's answer), prompts the fork with the frozen revision text in the context tail, and passive-writes the
answer back as an attributed `app.persona` entry holding the revision. The fork is a hidden `persona`-role thread of
the chat's Topic with main's memory and the delegating, organizing and asking tools removed. A Persona's **setup**
(`PersonaSetup`, ADR 0040) is the MCP servers, skills and apps it adds to the Topic's: the ask freezes it with the
revision, `registerPersona` keeps it in `app_persona_forks` (by the fork's chat) before listing the fork, and the
fork's scope is its Topic's setup, read live, joined with it, never with subagents; its refusals are words only. The
`exclusions` Personas had before (`20261028000100_persona_setup`) are no longer read; a receipt kept before setups
undoes without touching the setup. Stop aborts the chat's turns and marks their invocations `stopped`.

| Route | Purpose |
| --- | --- |
| `POST /api/personas` | Create one (`CreatePersona`, idempotent by operation id; 201). |
| `GET /api/personas/:id`, `PATCH /api/personas/:id` | One with its revisions, or a new revision (`UpdatePersona`; 409 unless `expectedRevision` is current). |
| `POST /api/organize/:id/undo` | Undo one receipt (409 `touched` after a later edit, `undone` after an Undo). |

The organize tools (`pi/organize.ts`: `topic_create`, `topic_rename`, `topic_archive`, `topic_setup`,
`persona_create`, `persona_update`) act only on the owner's direct request and write a receipt (`app_organize_receipts`)
with the target before and after; the same change from the UI writes one with actor `owner`. `topic_create` and the
Persona tools take a setup, and `topic_setup` adds to, removes from or replaces a Topic's (ADR 0040); the agent may only
add what the owner allows now (`refuseUnallowed`, `setup/catalog.ts`), its tool result names the routines a change
leaves without some of their tools, and the guide tells it never to use them to get past a refusal. A Persona's fork
has none of these tools. The workspace feed carries `personas`
(archived too), `invocations` and `receipts` (newest first) and the matching changes; the web lists them from it. Unit
tests (`personas.test.ts`) run the real migrations in `node:sqlite`; the local workerd owner cases in `persona-case.ts`
run in both native profiles. Neither is deployed-stage evidence.

## Cross-Topic retrieval

[ADR 0035](adr/0035-cross-topic-retrieval.md). The transcript index (`retrieval/index.ts`, functions of the agent's
database behind the `Retrieval` service) keeps an FTS5 index (`unicode61`, `bm25`) over one bounded, redacted excerpt
per indexed Pi entry: `app_transcript_excerpts`, the external-content `app_transcript_fts` with its triggers,
per-session progress in `app_transcript_index`, and the frozen sources of each use in `app_retrieval_uses` (migration
`20261026000300_transcript_index`). It reads Pi through `Conversation.entries` in entry-id windows and keeps only
entries the session owns (`entry.conversationId`), so forked history is indexed once under the chat that wrote it;
persona forks are skipped. Inputs, answers, share-backs, Persona answers, Delegate results and Topic seeds are
indexed; tool traffic is not. The `goblin.retrieval` extension (`pi/retrieval.ts`, in the default list, so in every
Conversation and thread but not in subagents or routine runs) catches its conversation up after each response, and
every search first catches up about 400 entries across chats. Each catch-up of a session holds that session's turn of
the agent's `KeyedLock` (`retrieval:<session>`), so two never read the same windows at once.

`search_chats { query, topic? }` turns the query into quoted literal terms joined with `OR`, ranks the top 20 hits,
groups them into ±2-entry ranges per chat and returns at most five sources with excerpts of at most 1,200 characters,
marked as quoted history. Without `topic` it searches active Topics that take part in search; a named Topic (name or
id) is searched alone whatever its state. The asking chat is never searched. Each call records its sources under
`tool:<session>:<call id>`, so a replay returns the same result; `details` is `SourcesDetails`.

Automatic retrieval: on the first model request after an owner input in a Conversation or thread (never a persona
fork), the `beforeRequest` hook searches the input's indexed text over the default Topics (never the asking chat), and
when a candidate passes the bm25 gate (-5 at 3,000 excerpts, scaled down by log size for smaller indexes) the cheap
model reranks up to eight with constrained JSON and may abstain (`model.aux` purpose `retrieval`, metered into the
daily budget; skipped once it is spent). At most three chosen sources go into the trailing `<goblin-context>` block as
a `<sources>` part for that request only, and the use is recorded as `auto:<session>:<input entry>` with `inputEntry`.
The task's memo `goblin.retrieval:<input entry>` keeps the choice (or the abstention), so later requests of the turn,
retries and recoveries re-inject the same sources without another rerank. No transaction spans the rerank.

## Topic memory

Every Topic's Conversation (Personal's is Main) keeps its own memory (ADR 0032): `ChatMemory`
(`memory/chat-memory.ts`) keys every row by chat id (its tables are functions of the agent's database in
`memory/store.ts`), and the `Memories` service turns one on with the `goblin.memory` and `goblin.recall` extensions
(`activate`, once; composition activates every Conversation that has none yet, and creating a Topic activates its
Conversation) and forgets a moved turn (`truncate(chat, size)`).
Activation, entry reads and builder writes resolve the chat's current Pi session on each use, so no memory row
names a session. The Builder document uses the generation API's `conversationId`; the builder works only for a
Conversation (`chatOf`, then `isConversation`). The additive migration `20261026000100_chat_memory` copied Main's
agent-wide memory into chat `1` with every idx, entry id and node unchanged; the old tables stay, no longer read.
Memory log entry ids remain Pi's globally unique ids.

A Conversation never ends, so it keeps a memory instead of an ever-longer context (`memory/`, after VictorTaelin's
OptChat gist). Every message of it since the memory was activated is logged in `app_chat_memory_log` with its Pi
entry id:

- the owner's and other authors' words, notes shared from threads, and the notes naming threads started with "+";
- the agent's replies, with their tool calls;
- tool results.

System entries and thinking are never logged. Memory text keeps at most 12 000 JavaScript string units from each
message's head and tail, plus a truncation note (`memory/log.ts`); Pi retains the original entry. This also bounds a
single-message `zoom`.

A background builder task (`pi/memory.ts`), which a Conversation starts after each of its responses, summarizes each
message in order into one line of about 512 bytes with the memory model. It then merges adjacent lines in pairs into a
binary tree (`app_chat_memory_nodes`). A short message, or a pair that fits, is its own line word for word, with no model call.
An empty reply uses up one of a line's three tries; when all three come back empty, the line keeps its source cut to
size, so one message cannot stall the builder. The view folds the tree toward 48 000 bytes (`memory/tree.ts`): one
line per recent message, and older lines covering more messages, merging the pair that is oldest relative to its size
first. Only the merges the view needs are built.

The builder writes the view into its Conversation as an `app.memory` entry, a Pi write submission whose head is that
Conversation's newest input, which is how Pi places a compaction. The model then sees the view and, verbatim, everything from that input
on, so nothing waits for the summarizer. A new view rewrites the start of main's context, which empties the
provider's prompt cache, so the builder places one only once main has run past the last view by an estimated 30 000
tokens (`FOLD_TOKENS`, `memory/memory.ts`); until then the newer messages stay verbatim after the old view.
`zoom(id, n)` (the `goblin.recall` extension) opens a line into the two under it, down to a single message. It is
offered in a Conversation and in threads branched from it, and reads the memory of the Conversation above the caller
(`conversationAbove`); a branched thread is bounded at its fork.

The summarizer's tokens count toward the budget, and the builder stops once the budget is spent. The memory begins at
activation: older history stays in Pi, out of the model's context once the first view lands. Once a view or a
compaction starts a conversation's snapshot later, the web reads the earlier entries through
`GET /api/conversations/:id/history?before=<entry>`; it never shows the marker entries themselves. Settings shows how many
messages main remembers; `GET /api/agent/memory?chat=<id>` reports the memory of that chat's Conversation (Personal's
without one). Unit tests prove the copy migration and per-chat isolation and truncation in `node:sqlite`; the local
workerd case `native-topics.ts` proves two Topics remember apart with each view placed only in its own Conversation.

## Typed decision proposals

[ADR 0031](adr/0031-typed-decisions-through-workers-ai.md). The `Decisions` service (`decisions/`, built by
`layers/decisions.ts` after the apps layer and before the workspace feed) judges the owner's chats and keeps the
proposals the owner confirms or dismisses. Its rules, question builders and strict answer and usage decoding are pure
code exported as `@goblin/runtime/decisions`, which the benchmark imports; fixture labels and provider experiments
stay in `bench/`. The critic (`decisions/critic.ts`) applies state-only rules first and asks Clef
(`decisions/client.ts`, the Worker's `AI` binding, five seconds at most) only for undecided ordinary evidence. A report
highlight is offered at 0.5107, a thread draft at 0.7503 and earlier work at 0.594, the frozen v4 thresholds; `none`
and `uncertain` are valid outcomes. The held-out evaluation supports owner review, not automatic actions.

`pi/subagent-relay.ts` hands a Delegate's final report to the service after its passive write, outside Pi commits,
keyed by its relay; the `goblin.decisions` extension (`pi/decisions.ts`, in the owner's chats only: helpers and
routine runs never install it) hands it each answered exchange after yield. A judgment checks resident authority and
the daily budget before any call, runs once at a time per proposal (`SingleFlight`), is fenced on the chat's current Pi
session and epoch and a digest of the exchange, and checks them again before it keeps a proposal; a failure or an
unavailable Clef proposes nothing and never fails the owner's turn. Only the dev stage binds `AI`; everywhere else
(prod, the local stack, the native test stacks) the hooks do nothing at all. Each Clef call is charged to the daily
budget as model `clef` and is one `model.aux` event of purpose `decision`; proposing, confirming and dismissing are the
flows `decision_propose`, `decision_confirm` and `decision_dismiss`.

The third judgment, cross-Topic context relevance (`decisions/context.ts`), follows the same exchange: after a bounded
catch-up, a search of the transcript index for the owner's newest message (ADR 0035's default Topics, never the asking
chat or a Persona fork) gives the top three sources automatic retrieval did not already give that message. The rules
decide what they can (a source sharing no significant word with the message is not relevant), Clef judges the rest,
and the sources at or above the threshold become one `context` proposal. Once the owner uses it, `goblin.decisions`'
`beforeRequest` hook adds the chat's newest such proposal confirmed in the last day to each request as a
`<chosen-context>` part of goblin's context block (quoted history, for that request only), and records an `auto`
source use (`decision:<proposal>:<entry>`) for each later owner message it serves, so that answer's source strip
names it.

Additive tables `app_decision_proposals` and `app_decision_labels` (migration `20261026000600_decisions`) keep the
proposals and the owner's first label. Every proposal made, labelled or made stale is a `decisions.changed` change, and
the workspace feed carries the newest open and confirmed ones in its snapshot (`proposals`) and each as a
`{ type: 'proposal', proposal }` change. `POST /api/decisions/:id` (the owner API's `decisions` group) takes
`{ label: 'confirm' | 'dismiss' }`; the same label again answers the same proposal, the other one is 409, and
confirming one whose chat moved on makes it stale (409). Confirming keeps a highlight or offers an empty thread draft;
Pi history and send targets stay as they were.

The web keeps the proposals as the workspace's `proposals` slice, and `decisions/hooks.ts` turns each open one into its
chat's "Only visible to you" row (`decisions/rows.ts`): a report highlight quotes the report with Useful, "This could
be a thread" quotes the owner's message with New thread, and "Earlier work may help here" quotes the first source with
Use, each with Dismiss; of a chat's thread and context suggestions only the newest of each shows. A choice posts the
label (`labelDecisionMutation`) and the row goes at once; a proposal gone, settled the other way or stale (404, 409)
stays gone, and any other refusal brings the row back. A confirmed thread suggestion then opens an empty new-thread
draft in that chat's channel (`Navigation.newThreadWith`); nothing is sent or moved. Unit tests cover the runtime
(`test/decisions*.test.ts`, `test/decision-*.test.ts`) and the web (`apps/web/test/decisions.test.ts`); the native
`decisions` probe and the owner's decisions case run with the probe's own Clef, never a paid call.

## Models

Typed decisions are the scoped Workers AI exception ([ADR 0031](adr/0031-typed-decisions-through-workers-ai.md)): Clef
judges bounded state and questions through `AI` after the rules decide what they can. It is never a chat model, and
its calls check and charge the budget like the cheap model's (input only, 5,000 tokens per Credit by default).

Each user picks the model their agent answers with, in the composer. The deployment offers `GOBLIN_MODEL_ID` (the
default) plus `GOBLIN_MODELS`, all served by the same LiteLLM key; `models.ts` names and groups them by route
(Google, Alibaba Cloud), because quota runs out per route. The pick is one row in `app_model_choice`; without one, or
when the deployment stops offering it, the default applies. Pi stores one model per conversation, set when it is
created, so before each turn the agent sets it (`PiSessions.setModel`) for the conversation the turn runs in,
skipping it when that conversation already has the model. Every offered model is registered with
Pi's `Models` under the one `goblin-litellm` provider. A failed model call shows its reason in the chat, and a
quota or outage failure points at the picker.

Every response may run to 32 768 tokens (`MAX_OUTPUT_TOKENS`, `pi/model.ts`): reasoning models spend part of it
thinking. pi-ai sends the limit on every request, less whatever the context leaves short of the window, so Pi
compacts while the context still leaves a whole answer (`reserveTokens` in `pi/harness.ts`). An answer that reaches
the limit ends with `stopReason: 'length'`: the chat shows "Cut off at the output limit" under what it wrote, and
Telegram adds the same line.

Housekeeping (thread titles, main's summaries and skill-draft decisions) runs on `GOBLIN_MEMORY_MODEL`. Set it to a
cheap offered model; the code does not choose by price. Unset or not offered, it falls back to the default
(`models.ts`, `memory/model.ts`). Its tokens count toward the owner's daily budget like any other.

## Model budget

Users share the deployment's model key, so each agent has a daily budget in estimated Alibaba Token Plan Credits,
the unit the plan bills (ADR 0026), per UTC day: Pro's 800, or the account's operator override (`daily_credits`). A
Pi extension (`pi/budget.ts`) records every model response's tokens in `app_usage_daily` and prices them in
thousandths of a Credit at its model's rate (`budget-credits.ts`): by default about 5 000 fresh input, 50 000 cached
input or 830 output tokens per Credit, Alibaba's own example, with per-model overrides and aliases in
`GOBLIN_MODEL_CREDIT_RATES` (Gemini 3.8 Flash is priced as Qwen 3.8 Flash; Clef, `clef`, has an input-only rate
of its own, and a Clef call whose usage is unknown is charged its whole 65,536-token context). The cheap model's calls
(titles, memory, skill drafts, an app's `llm` power), Clef's decisions and routine runs (`routines/usage.ts`, from
Pi's `pi.usage`) count the same way.
Compaction summaries in main and threads are not counted yet. Once the day is spent, new turns are refused with `BudgetExhausted`: HTTP 429 from the owner API,
or a tool error from `/mcp`. Telegram submissions check the same budget. Tool calls inside a running turn are blocked,
so a looping turn ends after one more reply. Pi reports and swallows exceptions thrown by hooks, so the in-turn lever
is blocking tools, not throwing. Only a spent budget blocks a tool as spent: an account without a plan is told to
subscribe, and a check that could not read the plan or the ledger blocks the tool as a failed check and is reported
(ADR 0026, amended). The allowance is the plan's, read through the agent's `Entitlements`.
Settings shows today's usage, and the composer shows it as a ring, re-read whenever
a run ends. On wider screens the composer also
shows how full the context was at the latest response, measured against the model's `contextWindow`. The model key's
own cap stays the backstop.

## Resident authority

The agent acts for the owner when the owner is not there, so it needs its own standing permission rather than a
borrowed browser session. `ResidentAuthority` (`app_resident`) is active for 30 days. Owner admission renews the
window on every owner API request except changing it (`POST /api/agent/resident`), the event streams, the files and
the OAuth callback; the internal API (inbound calls and hooks) never renews it. Turning
it off in Settings ("Work while you're away") sticks: activity does not re-enable it, only the explicit toggle does.
Model MCP tools, skills, inbound `ask_agent` and scheduled Telegram pulls and replies require current authority. The
owner's own `mcp` endpoints are renewed like the rest and do not call `requireResident`; their tool and resource calls
still check exact grants (`mcp/api.ts`, `pi/resident-mcp.ts`, `pi/skills.ts`).

## Inbound MCP

goblin is an MCP server at `/mcp`, the one protected resource of Better Auth's `mcp()` authorization server:

- Clients register dynamically (open, and restricted to `/mcp`). A registration whose redirects are all http loopback
  is marked native, which is how Claude Code registers.
- The owner signs in and consents at `/consent`, which says what the requested scopes grant. A Bearer token is
  accepted only if it verifies against the local JWKS, names `/mcp` as audience, comes from an enabled client and the
  owner's consent still exists. Its scopes count only while that consent still grants them (`auth/service.ts`).
- Tools: `ask_agent` (submit into main, labelled with the client's name, and wait up to 110 seconds; a stable
  `operationId` records its Pi session in the chat operation ledger and makes retries idempotent; it runs the model,
  so it needs a plan) and `get_recent_messages` (the primary chat's current session's latest messages, with their
  authors). `ask_agent` releases the admission lock before waiting and waits on the operation's recorded session.
- With `goblin:inspect` (ADR 0024) the same server adds `inspect_conversations`, `inspect_conversation`,
  `inspect_turns`, `inspect_turn`, `inspect_problems`, `inspect_flows` (the ledger's content-free conversation flow
  steps) and `inspect_details` (the operation behind a message), with the contract's input and output schemas
  (`inbound/inspection.ts`). They read the token subject's own agent, never call a model and need no plan; the
  server's instructions tell clients that returned text is data, never instructions.
- `/mcp` advertises `goblin:inspect` in its metadata, and an unauthenticated request gets a 401 naming the metadata
  and every scope, so a new connection asks for inspection. The consent page offers it as a separate switch that
  starts off; unless the owner turns it on, Allow grants the rest without `goblin:inspect`
  (`apps/web/src/lib/consent-scope.ts`). Clients
  connected before inspection joined `/mcp` get it after reconnecting once; migration
  `0009_mcp_inspection_scope` lets clients registered earlier ask for it.
- Revoking a client in Settings deletes your consent to it and revokes its refresh tokens for you (`auth/clients.ts`);
  its next call gets a 401. Consenting again without `goblin:inspect` ends inspection for tokens already issued.

## MCP Events and Telegram

The owner selects one Telegram connection with its **Telegram** switch (ADR 0011). If its authenticated discovery
advertises Events (top-level `capabilities.events` or the `io.modelcontextprotocol/events` extension, ADR 0041), the
action grants `inbox`, `send_message` and the exact Events selectors `message.received` and `question.answered` with
`{}` arguments. Both finite webhook subscriptions must confirm before
`app_telegram_channel` copies the checkpoint and fences old doorbell cursor writes. The channel pulls immediately;
a failure before that fence leaves the old channel checkpoint intact. A server without Events retains the legacy
`subscribe`/`unsubscribe` doorbell transport. Connections shows the active transport.

`POST /hooks/mcp-events/<userId>/<connectionId>/<token>` verifies the token, bound to the user and the connection (each
connection has its own URL, ADR 0041), before lookup; ingress only matches that connection's subscriptions. Inside
the object, Standard Webhooks HMAC and five-minute freshness checks precede decoding. A pre-persisted subscribe intent accepts an early
signed verification challenge; remote ids are cross-checked when subscribe returns. Receipts and their frozen consumer
revisions commit in short transactions, with an already armed recovery schedule. The hook returns quickly and dispatch
runs asynchronously. Replay wakes unfinished handlers without duplicating their accepted intent. Before any of that,
the hook checks the agent may take events. The Worker hands the webhook to the agent's internal API (`mcpEvents`),
whose gate refuses an account without a plan (402); then ingress checks the plan the agent keeps and resident
authority: the owner's own refusal (revoked authority, a forbidden connection) answers 410 and the producer drops the
subscription, and any other failure of either check (a plan lookup that failed) is reported and answers 503, so the
producer retries. A subscription is dropped as invalid only when its server is gone (`NotFound`) or its grant or
endpoint changed. A failed maintenance sweep is reported, then retried a minute later (`mcp/wake.ts`).

`message.received` and `question.answered` both pull the authoritative inbox into the primary chat's current Pi session:
the consumer schedules the channel's pull alarm at once (`channelPull`), as a doorbell does, and the pull runs there,
one at a time. Telegram admission and answer readback use its operation ledger binding. `ask_user` ends its turn; the
answer arrives as the owner's next inbox message. The existing id mapping is preserved: `tg:123` becomes
`telegram-tg-123`, and reply operations keep their sanitization/truncation. Main's replies and subagent reports go back
with `send_message`, escaped and chunked, using `app_channel_replies`. Submission acceptance is distinct from external
Telegram completion. Disabling cleans up Events while authority is available, then tombstones locally; finite remote
leases expire if authorized cleanup cannot run.

The dispatcher also binds MySkills `skills.updated` and `skills.list_changed`. Turning a server's skills on subscribes
to them only where its Events offer them to this connection; a server without them, or one that refuses its Events
(Sidequest's setup-only connection), still turns on, and its listing refreshes on its `ttlMs`. Their payload is
untrusted metadata; the handler persists a dirty catalog generation and invalidates the cache before acknowledgement.
A listing can clear only the generation it observed, and retained activations stay pinned. Gap controls trigger reconciliation;
termination stops lease refresh and surfaces health. Mail and workspace changes have no installed consumer yet.

The owner browses a connection's event streams before granting any (`GET /api/mcp/:id/events`, `Events.catalog`):
the plan, resident authority and a signed-in connection are enough, no selector grant is made, and each stream says
whether goblin can subscribe to it (poll and webhook). Descriptions are the server's claims, cut to 500 characters.

The client refreshes before the producer's ISO `refreshBefore` and polls on gaps or webhook outages. Bounds are
64 live subscriptions (maintenance reconciles every one; a tombstone is pruned once no delivery or binding
refers to it and its lease lapsed or its cleanup succeeded), 100 events per page, 256 KiB bodies, 15-second remote
requests (`EVENT_LIMITS.timeoutMs`) and 10,000 pending rows / 32 MiB.
Recovery sweeps process at most 256 deliveries and retain completed receipts for eight days; unfinished receipts
are never pruned. Workers cannot pin resolved DNS IPs; trusted DNS is the documented v1 deviation (ADR 0011).

## Run ledger

Pi records what was said; goblin records how each turn ran, beside it (ADR 0024). `PiRunRecorder`
(`telemetry/pi.ts`) follows Pi's commit listener from the moment Pi opens (`pi/harness.ts`), so it sees every
conversation (main, threads, subagents, routine runs) without an extension, and reads only committed records.
Before scheduling resumes, `telemetry/rehydrate.ts` restores live runs and submission ids through supported Pi inspection
and `LiveDoc`; the synchronous listener never calls Pi or awaits it. Final-answer events are processed before clearing
a run. The ledger supplies exact submission/task correlation when a cache entry is gone:

- **Turn:** an input submission from admission to settlement, by its operation id. Its source comes from the id's
  prefix (`telegram-`, `routine-input:`, `subagent:`, `persona:`, …; anything else is `direct`, the owner or an MCP
  client). An unanswered turn keeps Pi's reason.
- **Model attempt:** a generation task entering `request`, ended by the assistant entry it appends (or the task's
  fault): model, finish reason, input, output, cache and reasoning tokens, fixed error summaries, cutoff and
  empty-answer markers. The first committed partial
  marks the first chunk; Pi commits partials at most every ~100 ms. A retried attempt is a new event.
- **Tool call:** a tool task, ended by its result entry: name, family (`mcp`, `app`, `subagent`, `memory`,
  `builtin`), argument and result sizes, the MCP server and tool of an `mcp_call`, and `blocked`, `interrupted` or
  `error` with the first diagnostic. A call to a tool that is not there is one event, from the generation.
- **Compaction** tasks, and any other task that faults or is orphaned (a subagent relay, an anchor).

Outside Pi, the agent's services report to the same telemetry (`telemetry/report.ts`):

- **Model calls outside a turn** (`model.aux`): one cheap model per purpose (`naming`, `memory`, `skill`,
  `app_llm`, `retrieval`, and `decision` for Clef), with tokens and errors (`memory/model.ts`).
- **Remote MCP steps** (`mcp.request`): every connect, tool call, skills request and Events request, with server,
  tool, outcome code (`UpstreamMcp:timeout`), expected blocked waits and duration (`mcp/log.ts`). Resident callers pass
  explicit conversation/task metadata, stripped before SDK dispatch; shared connection discovery is marked without
  attributing it to a turn. Reporter failures cannot change or retry the call.
- **Telegram** (`channel.received`, `channel.reply`): each inbox message by mygram id and its turn's operation id; each
  answer `sent` in pieces, or `given_up` after a day.
- **Flow steps** (`flow`, ADR 0037): one content-free step of a conversation flow, recorded where it happens through
  `FlowEvents.record` or `withFlow` (`observability/flows.ts`), which never fails the flow it describes. The agent
  records every flow `FlowName` names: an owner's send, a client's ask and a Telegram message as they are admitted, a
  thread started (`start`, `reply`, `empty`), a move, a share-back, a close and a Stop, a Persona's ask and answer, a
  Delegate's spawn and report, a thread's announcement, a Topic created or archived, an organize Undo, a routine
  firing and report, a Telegram delivery, a decision proposed, confirmed or dismissed (and the Worker a browser
  crash). The operation id has its own column and
  the operation that caused it is
  `goblin.operation.parent`; the rest are allowlisted ids and closed classes. A `refused` step is stored `blocked`,
  an `error` step `error`. Ledger reads skip a row of a kind they do not know.

Each event goes to `app_run_events` (kept 30 days) and to one Workers Log line when it ends, through the logger below
(`event: "run"`, its ids,
`ms`, and attributes named after the OpenTelemetry GenAI conventions, `contracts/src/telemetry.ts`). Model and tool
calls also become spans (`chat {model}`, `execute_tool {tool}`, `telemetry/trace.ts`), with the same attributes and
the agent, conversation and operation ids. A call often starts in one invocation and ends in another, and a Workers
span cannot outlive its invocation, so each is one span written whole where it ends, its real start and duration in
`goblin.started_at` and `goblin.duration_ms`. Today only model calls outside a turn reach Traces: the spans of a
turn's calls, recorded from Pi's commit listener, are created but never exported (seen on dev 2026-10-06, cause not
yet found), so those calls are in the ledger and the log only. Never content:
ids, sizes, counts, timings, outcomes and fixed error summaries. Known fields are sanitized before fan-out and on
legacy reads; arbitrary provider, schema and remote error text stays in Pi inspection. Expected authority waits use
info log lines and an unset trace status. At start the agent marks whatever the last run left
`started` as interrupted and logs one `recovery` event; an event that ends after a restart says it resumed. Pi faults
the user's task if a commit listener throws, so the recorder and every sink are guarded and only log their own
failures. Verified with in-memory Pi (`test/telemetry.test.ts`) and local workerd (`native-telemetry.ts`, the
Telegram Events probe). Compaction summaries' model calls are not recorded yet.

The agent builds these pieces with `runTelemetry(storage, name, sinks)` (`telemetry/run.ts`, from
`telemetry/agent.ts`): its ledger, log and recorder. The recorder is attached and `recorder.restore(harness)` awaited
right after `Harness.open`, before scheduling resumes. Tests pass a `CollectedRuns` sink (`telemetry/events.ts`) to
read events in process, and `summarize(turn, events)` (`inspect/inspector.ts`) gives the per-turn numbers: attempts,
failures, tool calls and tokens. Attempt timing runs from the generation entering `request` to its assistant entry;
the first chunk is the first committed partial, so it is good to about 100 ms. The runtime package exports no
telemetry entry; the benchmark workspace imports `@goblin/runtime/memory` and `@goblin/runtime/decisions`.

### Logs, failures and references

Every line the runtime writes goes through one logger (`observability/logger.ts`, the runtime's only `console`
writer): `GoblinLogger` for `Effect.log*`, `logEvent` for named events inside Effect, and `writeLine` for synchronous
code outside it (the run log, Pi's commit listener). A line is one JSON object: allowlisted keys, each only with a value
of its shape (`LOG_KEYS`: where, operation, request, ref, agent, route, method, status, code, error type, frames,
counts, timings and a few more), then run attributes through their own allowlist (`telemetry/safety.ts`). The logger
reads a fiber's log annotations and spans only, never a log message or a cause. Event names are a closed list
(`LOG_EVENTS`: `client_error`, `failure`, `flow`, `http.failure`, `job`, `mcp`, `rpc`, `run`, `skill-learner`, `wake`).

A failure that should be seen is reported by the failure reporter (`observability/report.ts`, on Effect's
`ErrorReporter`): one `failure` line with where it was reported (`goblin.where`), its type (its `_tag` or class name),
the `file:line:col` locations of its stack and a severity, never its message. The typed answers an owner gets in the
normal course (every `AppError` but `Internal`: a 404, a 409, a 402) are not reported when they arrive as failures.
`reportFailure(where)` reports and keeps failing; `reportAndRecover(where, fallback)` reports and falls back, for a
legitimate fallback only; `expectedFailure` marks an error to log at `Info` or not at all. Every program the bridge
runs, every owner API request and every change handler is reported this way, and `toAppError` (`http/errors.ts`)
reports an unexpected failure where it becomes `Internal`.

References join what the owner sees to the logs:

1. The browser sends a fresh `x-goblin-request` id (eight characters) with every API request, and a write its
   operation's `x-goblin-operation`.
2. The Worker's edge forwards both with its own reference, `x-goblin-ref` (the request's cf-ray), answers with that
   header and `error.ref`, and logs a failed answer as one `http.failure` line (see The owner API).
3. Inside the agent, owner admission (or the internal gate) annotates the request's lines with `goblin.rpc`,
   `goblin.operation` and `ref`.
4. The web quotes the reference with a failure ("… · ref 7f3a9c12"): the answer's, or the request id when nothing
   answered (`describeError` and `messageOf`, `lib/query/app-error.ts`). Sign-in and `/health`, outside the API, do the
   same (`AuthRefused`, `auth/queries.ts`).
5. `goblin lookup <ref|request|operation>` finds the Worker's log lines that mention it, then shows the details of the
   operation they name.

A crash nothing on the page caught (a route that failed with a defect, an uncaught error or unhandled rejection) is
reported to `POST /api/client-errors` (`lib/query/crash-report.ts`): each distinct crash once, at most five a page
load, with the route id, the error's type, at most twelve `url:line:col` frames, the build and the failing answer's
reference, within 2 KiB; never its message, the URL or anything the owner typed. An answer the API gave is not a
crash. The Worker logs it as one `client_error` line and writes a `client_error` flow point; nothing is stored.

For the operator, flow steps also go to Workers Analytics Engine (`observability/ae.ts`, ADR 0037): the optional
`FLOWS` dataset (`goblin-<stage>-flows`), one point per operation (its first step), indexed by a hashed agent id (an
HMAC of the user id under a key derived from `GOBLIN_CREDENTIAL_KEY`), with closed classes, counts and timings and no
chat or operation ids. Without the binding nothing is written. `goblin stats` sums them per flow and outcome through
the Analytics Engine SQL API with the operator's own Cloudflare token.

### Inspection

The `Inspection` service (`inspect/service.ts`, over the readers in `inspect/inspector.ts`) reads the agent back
without changing it or calling a model. The queries are in `contracts/src/inspect.ts`:

- `conversations`: every conversation the agent keeps.
- `conversation`: a page of one conversation's Pi entries, oldest first, in full. Text is cut at 4000 characters and
  arguments or data at 2000, with `truncated` set. A leading author tag becomes `author`.
- `turns`: recent turns as one-line summaries (source, outcome, attempts, tool calls, failures, `error` events,
  tokens). A chat filter
  resolves to its current Pi session; historical events keep their recorded Pi session.
- `turn`: one operation end to end. It joins Pi's own settlement of the submission (`done` with its answer entry, or
  `unanswered` with a reason) with every run event of the operation, in order, and `coverage` names what the
  timeline cannot show: a restart mid-turn, events still open, a missing final answer, or a compaction's model call.
- `problems`: events needing attention since a time (default the last day); expected authority waits and confirmed
  recovered model retries are filtered before applying the limit. Pass `all: true` for the full problem history.
  Cutoffs, empty answers and coverage gaps remain visible. Tool failures remain until reviewed; a successful turn
  alone never proves a failed tool recovered. Successful auxiliary model completions are excluded, including a
  `length` finish on a bounded memory call; actual auxiliary failures remain visible. A failed flow step is a problem;
  a refused one (an answer the owner already saw) only with `all: true`.
- `flows`: flow steps since a time, newest first, by chat or flow.
- `details`: what happened behind one message, by its operation id or by the chat entry that is its answer or tool
  result: the operation's timeline (with its turn when it ran one) and `related`, the operations it came from and
  led to.

The agent answers them on its internal API (`POST /internal/inspect` with `{ query }`, no plan needed), which only
`/mcp` calls, for a client that holds `goblin:inspect` (see Inbound MCP). The owner's
own app reads `details` through the owner API (`GET /api/conversations/:id/details`, the `inspect` group), for a
message's Details sheet.

The agent reads itself too: main has a `diagnose` tool (`pi/diagnose.ts`, wired by `telemetry/agent.ts`), so the
owner can ask in Telegram why something failed. Without an operation id it returns the last day's problems and turns;
with one, that turn's timeline. Each event comes in a line (kind, status, timing, tool or model, error), never
content, and the result is marked untrusted because its private details can come from remote servers. It grants nothing. A conversation
that is not in `app_conversations` (a routine's run) has no entries page; its turns and events are still in the ledger.

## Storage

| Store | Tables | Owner |
| --- | --- | --- |
| Agent DO SQLite | `pi_*`, `cf_agents_*` and the other vendor tables | Pi, Agents SDK. Never touched. |
| Agent DO SQLite | `app_mcp_connections`, `app_mcp_registries`, `app_mcp_endpoints`, `app_mcp_credentials`, `app_mcp_oauth_pending`, `app_mcp_grants` | Drizzle: MCP metadata and authorization. |
| Agent DO SQLite | `app_resident`, `app_conversations`, `app_model_choice`, `app_usage_daily`, `app_metadata` | Drizzle: agent metadata and logical chat bindings (ADR 0030). |
| Agent DO SQLite | `app_chat_operations` | Drizzle: operation receipts per chat, pinned to their original Pi session, with kind, origin, target chat, parent operation, state and reason (`20261027000000_chat_operation_receipts`), pruned opportunistically after 30 days (ADR 0030). |
| Agent DO SQLite | `app_conversation_capabilities`, `app_execution_exclusions` | Drizzle: a helper's exclusions, set by its spawner (ADRs 0018, 0029); the owner's per-conversation switches were deleted (ADR 0040). |
| Agent DO SQLite | `app_persona_forks` | Drizzle: the setup each Persona fork answers with, frozen at the ask (ADR 0040). |
| Agent DO SQLite | `app_chat_memory_log`, `app_chat_memory_nodes`, `app_chat_memory_state` | Drizzle: each Topic Conversation's memory, keyed by chat id (ADR 0032). `app_memory_log`, `app_memory_nodes` and `app_memory_state`, Main's agent-wide predecessors, were copied into chat `1` and are no longer read. |
| Agent DO SQLite | `app_topics` | Drizzle: the owner's Topics, each with its Conversation's chat id (ADR 0032) and its setup (ADR 0040). |
| Agent DO SQLite | `app_transcript_excerpts`, `app_transcript_fts` (FTS5, shadow tables `app_transcript_fts_*`), `app_transcript_index`, `app_retrieval_uses` | Drizzle and raw FTS5 SQL: the cross-Topic transcript index and the frozen sources each run used (ADR 0035). |
| Agent DO SQLite | `app_skill_sources`, `app_skill_activations`, `app_skill_files`, `app_skill_drafts` | Drizzle: skills and draft tracking. |
| Agent DO SQLite | `app_channel`, `app_telegram_channel`, `app_channel_replies` | Drizzle: Telegram transport checkpoints and replies. |
| Agent DO SQLite | `app_mcp_event_grants`, `app_mcp_event_subscriptions`, `app_event_deliveries`, `app_mcp_event_consumers`, `app_event_consumer_receipts` | Drizzle: exact Events grants, leases, encrypted receipts and independent acknowledgements. |
| Agent DO SQLite | `app_skill_catalog_state` | Drizzle: durable catalog invalidation generations. |
| Agent DO SQLite | `cf_workspace_files` | `@cloudflare/shell`'s Workspace: the owner's files (ADR 0022), vendor-owned like `pi_*`. |
| R2 `files` | `agents/<userId>/files/…`, `agents/<userId>/app_<name>/…` | Shell: the owner's and each app's files over 128 KiB. Deleting the account empties the prefix. |
| Agent DO SQLite | `app_agent_apps`, `app_agent_releases`, `app_agent_artifacts`, `app_agent_views`, `app_agent_state`, `app_agent_snapshots`, `app_agent_receipts`, `app_agent_events`, `app_agent_powers`, `app_agent_usage`, `app_agent_jobs` | Drizzle: agent apps, their releases, code and views, state and revisions, rollback snapshots, receipts, events, the owner's answers to their powers, their daily usage and their schedules (ADR 0021). |
| Agent DO SQLite | `cf_workspace_app_<name>` | Shell: each agent app's own files. |
| Agent DO SQLite | `app_registry` | Drizzle: every App the workspace shows, by source: an MCP App per Pi session and call, with logical `chat_id` placement, an agent app per name (ADRs 0020, 0021, 0030). `app_apps`, its predecessor, was copied in with the same ids and is no longer read. |
| Agent DO SQLite | `app_run_events` | Drizzle: the run ledger, turns, model attempts and tool calls without content, 30 days (ADR 0024). |
| Agent DO SQLite | `app_decision_proposals`, `app_decision_labels` | Drizzle: typed decision proposals and the owner's first label of each (ADR 0031). |
| D1 `goblinAuth` | `user`, `session`, `account`, `verification`, `jwks`, `rateLimit`, `oauth*` | Better Auth, `apps/runtime/migrations`. |
| D1 `goblinAuth` | `app_billing_accounts`, `app_billing_subscriptions`, `app_billing_inbox`, `app_billing_checkouts` | Drizzle: account payments and durable reconciliation. |

The withdrawn Members feature left dormant auth D1 tables and DO columns/tables. Applied migration files and keys
remain intact to preserve real data and migration history; the runtime no longer reads or writes that access metadata.
See [ADR 0014](adr/0014-members-and-workspace-authority.md) for the withdrawal.

Application tables are declared in `storage/schema.ts` and migrated inline by `storage/migrations.ts`, which applies
the area lists in `storage/migrations/` (`base.ts`, `conversation.ts`, `decisions.ts`, `setup.ts`) in key order.
`app_client_sessions` was dropped when inbound clients moved to main; it is not a current table.

Logical chat migration is additive: existing chat keys, capabilities, exclusions, titles, close/read marks and tree
parents stay in place. Pi entries, tasks, submissions, request ids and documents remain Pi-keyed, as do
`app_mcp_approvals`, MCP App call reads, `app_skill_activations` and `app_run_events`. `fork_entry`, `spawner_session`
and memory entry ids keep their original Pi identities. Routine reports, share-backs, thread-start notes and subagent
reports resolve the current target chat while its shared directory lock is held, then submit to Pi; passive write
acceptance starts no model turn and proves no external effect.

The chat layer has unit proof for lookup, operation retries, retention, CAS ownership and admission locks, plus a
local workerd profile that binds chat `1` to a fresh non-root Pi session in test subclasses before service
composition. Owner, helper, routine, channel and memory cases run under that profile; explicit owner and inbound
proofs assert the non-root session and an empty root transcript. The AST guard bans root constants, session-less
harness submission/session calls, and a `ChatDirectory` built outside the conversation layer (`layers/conversation.ts`)
and tests. These
prove local behavior; deployed-stage, live-provider,
Telegram-service and remote-eviction acceptance remain separate.

Better Auth lives in D1 because the Durable SQLite adapter's async transactions and affected-row semantics do not
meet its contract (ADR 0001). SQLite transactions are short and never span model or network calls.

## Infrastructure

`apps/web/alchemy.run.ts` declares the Vite Worker, the `PersonalAgent` namespace, the D1 database, the `FILES` R2
bucket, the `FLOWS` Analytics Engine dataset (`goblin-<stage>-flows`, ADR 0037), the `LOADER` Worker Loader
(Dynamic Workers, open beta, Workers Paid) and, on dev only, Workers AI as `AI` for typed decisions (ADR 0031; without
it decisions judge nothing); it is the only deployment entrypoint.
`scripts/stage.ts` builds `packages/app`'s toolchain before Alchemy runs. The local stage runs in workerd with CLIProxy; the dev stage calls Railway LiteLLM with a
dedicated model-limited, budget-capped key. Offered models and Credit rates come from stage configuration; the per-account allowance comes from its plan or
operator override. The key's provider caps and shared quotas are managed outside this repository; source does not prove
their active values. Secrets are Worker secret bindings, never in the browser bundle. Every stage turns on Workers
Logs (with invocation logs) and Workers Traces for every request (`scripts/stage-config.ts`); Cloudflare keeps both
seven days. The run ledger's log lines (see Run ledger) are among them.


## Stage origins

Dev runs at `https://dev.goblin.surf`; production runs at `https://goblin.surf` with `www` redirecting to the apex. The fresh Goblin stack creates
`goblin-dev-auth`, an empty native Agent namespace and new auth/encryption secrets. It imports no users, transcripts,
connections or grants. Production uses separate resources, secrets and a dedicated model key; its first release is invite-only until owner bootstrap. `GOBLIN_DOMAIN` and `GOBLIN_ZONE_ID` attach
the stage's custom domain; prod additionally has a `www` alias. Both Worker entry points redirect alternate origins
before auth, hooks or rendering: 301 for GET/HEAD, 308 otherwise, preserving path/query with `APP_URL` as authority.
Auth trusted origins and inbound MCP metadata derive from that origin. Dev mail subjects include its host; prod
subjects have no prefix. Domain reachability and actual OTP delivery require separate live checks.

The inbound Agents SDK handler explicitly allows only the configured `APP_URL` hostname for both Host and browser
Origin validation. The SDK defaults otherwise reject browser requests on custom domains. A native workerd regression
proves a custom-domain Origin succeeds and a foreign Origin is rejected.

## Plans and payments

The account boundary in auth D1 is independent of the agent's Pi store (ADR 0015). `billing/` owns customers,
subscriptions, checkout rate accounting and the verified webhook inbox through Drizzle `app_billing_*` tables. Better
Auth continues to own identity and inbound OAuth. No billing operation writes Pi or Agents tables.

`GET /api/billing/state`, `POST /api/billing/checkout` and `POST /api/billing/portal` (the account API's `billing`
group, answered in the Worker) authenticate the owner without resolving an Agent.
Product and checkout metadata are selected server-side. Checkout and the return page grant no
access: `POST /hooks/dodo` verifies Standard Webhooks HMAC over the raw body, checks freshness and stores the first
body under `webhook-id` before responding 2xx. A leased background run updates the subscription; an hourly Worker cron
retries unfinished receipts and reads stale subscriptions back from Dodo. Provider timestamps prevent old events
from overwriting newer states. This is durable idempotent reconciliation, not exactly-once provider effects.

The owner API and the account API's `clients` require an active plan, read fresh from auth D1 at the Worker's edge,
before selecting the user's Agent. Inbound MCP and the user-bound hooks reach the Agent through its internal API,
whose gate checks the plan the Agent keeps (402 without one); the Worker reads none for them. Inside the Agent, owner
admission, the internal gate, client and background runs, the model budget and every tool call check its
`Entitlements` service, which keeps an active plan for 60 seconds (`cachedPolicy` in `billing/gates.ts`, ADR 0015
amended); a plan that is not active, or a read that failed, is not kept. No lifecycle lock is held around the D1 read.
A cancelled plan can keep the Agent's own background work, and its hooks and inbound clients, going for up to a minute
after the edge stops admitting the owner. Pro is $10/month, without trial or free tier; active
or cancelled subscriptions remain usable only through their recorded paid period. Failed renewals use the provider's
grace end or three days after the period end; missing dates fail closed. Existing users at the billing migration get a
dev-only override, which grants nothing on prod. Operator overrides may supply their own allowance.

Each Agent's usage ledger still records its owner's UTC-day spend, while the allowance now comes from that account's
plan (800 Credits a day for Pro, ADR 0026), at the Credit rates the stage configures; the defaults are Alibaba's
example rates and need operator review against the plan's real billing.

The browser reads billing state before mounting agent pages; unpaid accounts reach `/subscribe`. The return page
polls verified state and Settings opens the Dodo portal. `/terms`, `/privacy` and `/refunds` are draft public pages,
pending operator identity and legal review. Native workerd tests verify signup, injected checkout, activation,
replay, stale updates, cancellation, grace and per-account allowances with real D1/Agent storage. They do not prove
live Dodo delivery or merchant onboarding.

## Isolated memory experiments

The [benchmark workspace](../bench/README.md) replays private, redacted Claude and Hermes histories through native Pi write
submissions in its own local workerd actors. OptChat, native compaction and lexical archive search share fixed source
cutoffs and bounded API/retrieval allowances. Source tool calls are transcript evidence; the benchmark installs only
recall/search tools and never executes historical commands. Expected claims stay on the coordinator host, outside
worker requests. Private manifests, source hashes, API ledgers, native contexts and identity-bound semantic reviews
make runs inspectable. Recall v2 compares the four memory/search combinations with a coupled DeepSeek writer and
reader, enforces phase and cutoff allowances, and requires a durable operational receipt before the later cutoff.
Blinded packets preserve unmodified answers; separate machine/human votes and adjudication provide semantic scores
alongside strict format/evidence results. Shared construction is charged once per memory. This local recall
experiment does not mutate a deployed user's agent or prove coding continuation.

The overnight coordinator binds multiple frozen corpora and monotonically extended memory artifacts to one durable
budget covering native preflight, construction, answers, independent machine review and retries. Native replay uses
bounded closed tool exchanges; search pairs reuse checkpoints, while probe forks isolate generated answers. Build
receipts distinguish cold, extended and reused work. Blinded Muse findings remain diagnostic until independent human
review; real source checkpoints and explicit product criteria do not authorize production promotion.

## Routine definitions

`routines/store.ts` stores bounded drafts and immutable operation receipts in application SQLite. A model can propose a
typed definition (`routine_propose`, which ends its turn), list (`routine_list`) or pause (`routine_pause`), one typed
tool each (ADR 0027); only an authenticated owner may confirm the exact revision. Routine writes require
an exact configured Origin and `x-goblin-csrf: 1`. Edits clear confirmation and stale revisions return 409. Settings
shows the prompt, exact tool pairs, timezone, budgets and Telegram policy before confirmation. A routine lives in a
Topic, and its runs are bounded by that Topic's setup as well as its allowed tools (ADR 0040): each `RoutineView`
carries `topic` and `outsideSetup`, the allowed tools the setup does not hold now, read live so a proposal or a
routine's page can flag them; a run that calls one gets the words-only `not-in-topic` refusal (code `not_in_topic` in
its ledger), and a setup edit answers the routines it leaves short.

Confirmed reminders and cron schedules use native dated Agent callbacks carrying routine ID, revision and firing
instant. A short application transaction claims each firing and advances its watermark before rearming; one newest
catch-up replaces missed slots, with a 24-hour window and one encrypted pending trigger while busy. Reconciliation
repairs missing schedules and removes only routine-owned wakes. The earliest-wake check considers future jobs only:
Agents includes the currently firing row in `listSchedules`, and counting it would suppress the next report/recovery
sweep. UTC reminders require an explicit offset. The
numeric cron parser enforces 15-minute spacing, skips spring DST gaps and chooses the earlier autumn repeated instant.

Pi background Anchor/Reporter tasks create and recover an empty task-owned run conversation, registered as a thread
without copied capability rows or an ordinary main-start note. The confirmed MCP ceiling narrows `Setups.scope`.
A dedicated per-run model provider checks resident authority, entitlements, deadlines and committed usage before
every model dispatch, including compaction. MCP checks repeat at the HTTP dispatch seam after token refresh, with
local correlation headers removed before egress. Main Stop leaves background runs alone; run Stop and archive fence
and abort owned conversations. Questions use sealed shared interaction receipts and authenticated same-session answers.

Committed `pi.usage` counters, including compaction, project into app-only cumulative watermarks and UTC-day
receipts: tokens for the routine's own caps, Credits for the owner's daily budget. Replay does not charge twice; a model response already in flight may overshoot a cap. Settlement freezes a
scrubbed summary and one `app.routine` parent write with a stable request ID. A routine belongs to a Topic
(`app_routines.topic_id`, migration `20261026000500_routine_topics`, ADR 0032): the Topic of the chat whose
`routine_propose` drafted it, Personal for one proposed through the owner API or before Topics. Its run conversation
sits under that Topic's Conversation and its report is written there; while the Topic is archived (archive leaves
schedules running in v1), runs and reports go to Personal instead. Telegram reporting is separate authorized
plumbing with frozen bytes/server, stable operation ID, five bounded attempts over at most 15 minutes, and a separate
remote acceptance receipt. Pi acceptance does not establish external delivery. Additive migrations …210/…211/…212 modify
only application tables.

Event confirmation grants the exact connected server/name/canonical-arguments selector after authenticated review;
its arguments must satisfy the producer descriptor schema. `routines/events.ts` binds `routine:<id>` and the current
revision to ADR 0011's static dispatcher. Shared leases survive until their last consumer retires. Each admitted
occurrence claims a losslessly escaped event ID, seals scrubbed bounded metadata, and labels it as untrusted data
in the fresh run input. Replays remain no-ops across revised consumers, even after ingress receipts expire. At most
one event run per minute is admitted across the agent; busy or spacing conflicts replace one sealed pending firing,
whose durable handoff and consumer acknowledgment commit together. Gap controls show recovery health and use the
originating authoritative poll; verification and termination create no model turn. Termination pauses the routine
and requires owner reconfirmation. Pause/edit/archive retire the consumer; pause advances an Event revision so a
retired receipt cannot become live again. Local signed-fixture proof is separate from real producer acceptance. See
[ADR 0012](adr/0012-routines.md).

## Deferred Home dashboard

Main contains the transcript and composer, without a dashboard above the input. It opens at the transcript's end and uses the same jump button as other conversations. Apps follow page > inline placement; saved Home tiles no longer displace their tool-row views. The browser has no Home pinning, edit mode, tile renderer or special receipt actions.

The runtime Home service, its tools, contracts and application tables remain active, and the workspace feed carries the layout (`home`); the owner API has no Home endpoint. Layout revisions, operation replay, owner authority and app-deletion cleanup still apply. Saved layouts and app state remain intact for a later UI iteration (ADR 0025). Layout edits currently have no visible browser surface; the agent's guidance says so and does not offer Home placement.
