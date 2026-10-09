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
  Worker -->|DO RPC| Agent[PersonalAgent DO]
  Agent --> Pi[(Pi tables)]
  Agent --> App[(app_* tables\nDrizzle)]
  Agent --> MCP[MyPlan, MyBrowser\nOAuth, refreshed in the DO]
  Agent --> Model[Model gateway]
```

## Worker

`apps/web/src/worker.ts` sends pages to TanStack Start and the routes below to `apps/runtime/src/worker.ts`.
Runtime paths below are relative to `apps/runtime/src/`; browser paths are relative to `apps/web/src/`.

| Path | What happens |
| --- | --- |
| `/health` | Stage, service name, sign-up mode and whether mail is configured. |
| `/.well-known/oauth-protected-resource*` | Protected-resource metadata for `/mcp`, the same document at every path. |
| `/.well-known/*`, `/api/auth/*` | Better Auth: sign-up and sign-in, the OAuth authorization server for inbound clients. |
| `/mcp` | goblin's own MCP server; a Bearer token from an inbound client reaches the agent of the user who consented, and `goblin:inspect` adds read-only inspection (ADR 0024). |
| `/api/*` | Owner API. A session cookie selects the signed-in user's agent; writes reject an `Origin` header if it names another origin. Browser writes under `/api/mcp/`, `/api/apps`, `/api/agent-apps`, `/api/home`, `/api/files` and `/api/routines`, plus queue removal, also require the same-origin CSRF marker. |
| `/hooks/mcp-events/<userId>/<token>` | Signed MCP Events; the user-bound route token is checked before object lookup. |
| `/hooks/myagent/<userId>/<token>` | Legacy Telegram doorbell fallback for servers without Events. |

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

The owner API forwards to the agent object over DO RPC. Workers RPC drops custom error classes, so every DO method
returns an encoded `RpcResult`; the Worker decodes it and maps the tagged error to a status in one place
(`http/errors.ts`, `http/respond.ts`). Failures are logged as one JSON line with route, request ID, status and
error tag, never bodies or credentials.

## The agent object

`PersonalAgent extends Agent` and registers the native `PiHarness` with the Agent lifecycle. Pi owns transcripts,
tasks, submissions, recovery and tool replay. The object builds one Effect `ManagedRuntime` lazily, providing its
services: `Mcp` (the MCP host), `Resident` (resident authority), `Chats` (logical chat resolution), `Conversations` (the conversation registry), `Topics` (the owner's Topics),
`Budget`, `Models`, `Memory`, `Skills`, `Learner`, `Channel` and `Files` (`services.ts`). DO methods are thin: each runs one Effect
program and encodes the exit. PiHarness and Pi Durable are experimental; Alchemy is a pinned beta and Drizzle an RC. `@shadcn/react` is pinned at
0.3.1 and patched (`patches/shadcn-react/README.md`): its MessageScroller carries unreleased upstream fixes.

Conversations (`conversations.ts`): every agent has one **main** conversation, stable chat id `1` (`PRIMARY_CHAT`),
where the owner's browser and every inbound MCP client talk. `ChatDirectory` resolves that chat to its current Pi
session. A fresh agent starts with Pi's root session `1`; a future rebind can change the session while `/c/1` stays
the same. A message from anyone but the owner's browser starts with an author tag
block (`[from Claude Code]`, the `authorTag` contract), so the model and the web both know who wrote it. Side
**threads** are Pi conversations of their own: branched from a message of any open conversation (a Pi fork at that
entry, so the thread sees its parent up to there and the parent never sees the thread), at any depth, or empty under
main (ADR 0017). `app_conversations` registers each one as a chat tree (`parent_session`: its parent chat), with its
kind, title, origin and close time. Its existing `session_id` primary key is the stable chat id (`chatId` in Drizzle);
`pi_session` names the current Pi session, uniquely owned by that chat, `epoch` fences rebinds and `role = 'primary'`
marks Main. A helper's immutable `spawner_session` keeps its anchor and relays on the Pi session that started them.
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
crumb. A message offers Reply in thread and Copy in a small toolbar over its top edge where a pointer rests, and on a
touch screen once the message is tapped. Reply in thread opens a draft in the panel, with the focus in its composer,
that branches the thread only when it is sent, because Pi cannot delete a conversation; `/new-thread` moves the
composer's draft into a new thread's draft the same way. The channel and the panel follow conversations through one
stream pool (`lib/stream-pool.ts`): one event stream per conversation however many show it, at most eight following
beyond those on screen, and one off screen stops following after ten seconds, resuming from a fresh snapshot when it
comes back. Start thread, a toggle in the composer (and `/new-thread`), posts the message as the head of a new thread whose
reply lands there (`POST /api/conversations/:id/threads`, one operation id per draft), and the panel opens on it;
turning it off keeps the draft, its files and references. A server without that route gets the thread the older way:
a new empty thread of the Topic, then the message in it. Move to thread, in the toolbar of the owner's messages in a
channel (`POST …/move`), leaves the message as the thread's head and opens the thread; a refused receipt (such as
`streaming`) disables it for that message, with the reason, until the run ends. The shell asks once a page load
whether each route exists (`lib/features.ts`: an empty body is refused as invalid where it does, not found where it
does not) and offers neither where it does not. The transcript draws what those runtimes write
(`components/parts/drawn-parts.tsx`): a thread's head with the thread's summary ("Moved to a thread" for a moved
turn, whose own entries a later entry's edits omit), the owner's message to Personas with whom it went to, a Persona's
answer and a Delegate's result as attributed messages (a mark, a name, Persona or Delegate), and a Topic's brief.
Personas still answering show after the transcript ("answering…", from the feed's invocations). With Personas on the
server the composer offers them as `@` references (with their avatars), and with two or more tagged a Together or
In turn choice that is sent as `personaOrder`. What an answer used from other chats shows as a strip under it: a
`search_chats` call's `SourcesDetails`, and automatic retrieval from `GET /api/conversations/:id/sources`
(`lib/sources.ts`), each source opening its chat. Owner-only messages (`EphemeralMessage`, "Only visible to you")
have a slot after the entry they follow and a provider (`components/shell/ephemeral-slot.tsx`) that nothing fills
yet.
A thread started with "+" tells its channel its name once it has one (ADR 0010): the channel gets one
`app.thread_started` note, `[thread started: "<title>"]`, and its transcript shows that thread's summary.
**Start thread** ([ADR 0034](adr/0034-move-to-thread.md), `chats/thread-heads.ts`) posts the owner's message as the
head of a new Thread instead: `POST /api/conversations/:id/threads` forks the chat at its newest entry outside a
running turn (an empty Thread when it has none) in the same Topic, writes an `app.thread_head` entry
(`ThreadHeadData`, request id `thread-head:<op>`) into the chat as a passive write whose model text is a bounded `[the
owner started a thread: "…"]`, then submits the message into the Thread through the ordinary owner path.
`app_conversations.origin_op` (unique) makes one Thread per operation id, also for concurrent repeats.

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

The owner API is conversation-scoped:

| Route | Purpose |
| --- | --- |
| `GET /api/workspace/events` | The workspace feed (SSE): a `WorkspaceSnapshot` of every conversation and kept App and what each conversation that is not idle is doing (`working`, `waiting` on subagents), then batches of `WorkspaceChange` (`workspace/feed.ts`, from Pi's task graph and the registries' writes). A tab skips any item or change it cannot read, so a newer server never stops it. |
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
| `GET /api/conversations` | List registered conversations (`ConversationView`), closed ones included, each with its `parent`, where it branched (`forkEntry`), and its own `replies` and `lastReplyAt`, counted from Pi (`replies.ts`). |
| `POST /api/conversations` | Create an empty thread (`{}`) or branch an open conversation at an entry (`{ from: { conversation, entry } }`). |
| `PATCH /api/conversations/:id` | Rename, close or reopen (`closed`) a thread or subagent, or pin a subagent open (`keepOpen`). Closing stops it and everything under it; main cannot be changed this way. |
| `PUT /api/conversations/:id/read` | The owner has seen its newest reply: `read_at` moves forward to now, and the feed carries it as `readAt` (a later `lastReplyAt` is unread). |
| `GET /api/conversations/:id/capabilities` | What the conversation lets its agent use (`ConversationCapabilities`): each server with a granted tool and those tools, each skills library, subagents, and for a thread whether it has its parent's switches (`sameAsParent`). |
| `GET /api/conversations/:id/composer` | Conversation-scoped connected servers, enabled skills by stable URI, existing helpers and unavailable libraries. |
| `PATCH /api/conversations/:id/capabilities` | Switch one `CapabilityTarget` on or off there (only what is shown can be switched off), or `{ reset: 'parent' }` a thread back to its parent's switches. A subagent's are not editable. |
| `GET /api/conversations/:id/queue` | Ordered queued input IDs, modes and contents for Main and ordinary threads, from Pi InboxDoc. Passive writes, helpers and routine inputs are excluded. |
| `DELETE /api/conversations/:id/queue` | Remove a queued input by positive safe-integer `submissionId`, with the same-origin CSRF marker. Returns `removed`, `already_started`, `already_settled` or `not_found`; never stops a running input. |
| `POST /api/conversations/:id/threads` | Start thread (ADR 0034): the `SendMessage` body is posted as the head of a new Thread of this chat and answered there. Returns 201 `{ thread, receipt }`; the same `operationId` returns the same Thread (another chat's is 409). Strict CSRF marker. |
| `POST /api/conversations/:id/messages` | Submit `input`, a stable `operationId`, optional `appContext` (by App id), up to eight `attachments` (owner file paths that must exist) and up to sixteen stable composer `selections`; skill-only input is allowed. Returns 202 acceptance. |
| `GET /api/files?dir=` | A directory of the owner's files (`FileListing`): `/uploads`, `/agent` or a folder under one, with the storage in use. |
| `GET`, `PUT`, `DELETE /api/files/content?path=` | Download, write (the body, `content-length` required) or delete one of the owner's files. Downloads are attachments, except PNG, JPEG, GIF and WebP, which open in place; all are sandboxed by CSP. |
| `POST /api/conversations/:id/stop` | Stop a conversation or one `operationId`, and the subagents it started (not its threads). |
| `GET /api/conversations/:id/snapshot`, `GET /api/conversations/:id/events` | Pi snapshot or SSE snapshot followed by committed batches. |
| `GET /api/conversations/:id/history?before=<entry>` | Earlier entries, oldest first, with a `more` flag. |

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
own relays live; it parks on those), then posts the newest answer once into the spawner as an input labelled `[from
subagent <name>]`, which the spawner answers. Request ids keep a restart from delivering or reporting twice; of
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

**Chat admission** ([ADR 0030](adr/0030-logical-chats-over-pi-sessions.md)): owner, inbound MCP and Telegram operations
first record `(chat_id, operation_id)` and the selected Pi session in `app_chat_operations`, then submit to that
session. A retry uses the recorded session, even after a rebind; the intent row alone proves no Pi acceptance, so
retry still submits the same operation for Pi to deduplicate. Rows older than 30 days are pruned opportunistically.
The in-isolate per-chat lock covers admission only, and releases before model execution or waiting for an answer.
`rebind` compare-and-sets the expected session and epoch, rejects a session owned by another chat, and increments the
epoch. It notifies listeners to close that chat's SSE streams and emit a workspace change. There is no production
mover yet: Move to thread remains future work; Topics and their memory are below.

**Capabilities** (ADR 0010, `capabilities/`): each conversation can switch off, for its own agent, a connected server,
one granted tool of it, a skills library, or subagents. `app_conversation_capabilities` stores only what is off, so a
tool granted later is on everywhere. `CapabilityProfiles.scope(session)` maps the calling Pi session through
`chatOf` to its current chat, then reads that chat's switches and, for a subagent, those of every chat above it,
live at any depth (an unknown or no-longer-owned session,
or a broken or cyclic chain of spawners, may use nothing). A thread copies the switches its parent works under as it
is registered; "Reset to where it came from" copies them again. What is off is hidden from the model there: `mcp_list`
leaves it out, the `skills` section does not list or fetch that library, and Pi's per-conversation tool filter
(`configure({ tools: { remove } })`) drops the subagent tools, whose section then hides too; Pi stores the filter as
tool names, so when those names changed every filtering conversation's filter was applied again once
(`CapabilityProfiles.retoolOnce`). A call that still arrives runs nothing: `mcp_call`, `skill_activate`, `skill_read`,
`subagent_spawn` and `subagent_send` check the scope before anything else (before the grant check or any connection)
and return an error result with details `{ kind: 'capability-off', target }` (`pi/capabilities.ts`), which the web
turns into an owner-only "Turn on here" card. In a subagent the result has words only. The owner's console and an
App view and job calls carry no conversation. Agent-initiated app calls carry their conversation through nested apps
and MCP powers, so its exclusions are checked live at dispatch; Telegram and inbound clients talk in main, so main's
switches cover them.

The persona contributes two static system-prompt sections (`pi/persona.ts`): who the agent is, and that remote content
is untrusted data. The system prompt holds only text that does not change between requests: pi-ai folds every change
of it into the one leading system message, which empties the provider's prompt cache. What does change (the apps with
their versions, members and last errors; the skills on offer) goes into one trailing `<goblin-context>` message that
`beforeRequest` hooks add to each request (`pi/context-tail.ts`), marked as goblin's note and not the owner's. Pi
never stores it, so everything before it stays a cacheable prefix. The `mcp_list` and `mcp_call` tools
(`pi/resident-mcp.ts`) are how the model reaches the owner's MCP servers; both require current resident authority, and
`mcp_call` is marked unsafe to replay. `mcp_list` shows each tool's input and output schema (the server's, untrusted
data); `mcp_call` takes its `arguments` as an object or the JSON string of one, and returns the server's result as
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
connection: a snapshot of committed Pi entries, then batches, with a heartbeat. Rebind closes the stream; on reconnect
it starts again from a fresh snapshot. The workspace feed maps Pi task activity back to current chat ownership.
`ConversationView.primary` is an optional boolean; `WorkspaceSnapshot.primary` is an optional chat id for compatible
readers.

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
bottom drawer that a swipe down closes. The view follows a streaming reply only while the reader is at the end, and
otherwise offers a jump back. The chat's bar and the composer float over the transcript as translucent chrome. Assistant Markdown is set by shadcn/typeset, whose append-stable rules keep earlier blocks still
while a reply streams.

Tool calls remain quiet expandable lines (`ToolCall` in `packages/ui`). Opening one shows labelled Input and Output
sections (`ToolPayload`), with the local `JsonView` adapted from MIT-licensed `mnove/json-view-cn`. The root opens,
nested branches fold, long strings expand on request, and each object or array shows 50 children at a time. The web
selector (`lib/tool-payload.ts`) reads the existing redacted MCP envelope: structured output first, then individual
content blocks, suppressing a duplicate JSON text block while keeping additional prose and non-text blocks as data.
Text that reads as Markdown opens Formatted (`lib/markdown.ts`), judged by the CommonMark and GFM grammar the renderer
parses: a table, two kinds of anchor (an ATX heading on its own line, a fenced code block, a table), or one anchor
among three kinds of signal. YAML and script comments, diffs, tracebacks and listings stay plain, because a missed
document is still readable and a false one would mangle data. `ToolMarkdown` sets it in the compact `typeset-tool`
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

Servers come from `GOBLIN_MCP_SERVERS` (JSON: `serverId`, `endpoint`, optional `issuer` and `resource`) and from
the owner, who may add up to sixteen by URL (`app_mcp_servers`, ADR 0006). An added endpoint is a public https
address (`mcp/endpoint.ts`), and its server card labels it as the server's own claim. Configured servers win on ID
and cannot be removed. Removing an added server forgets its row, endpoint binding, credentials, pending sign-ins and
grants in one transaction. Connections also offers a shelf of suggested servers (`mcp/suggested.ts`), with source
comments recording their connection checks. One tap adds and connects. It also searches MCP registries that speak
the generic registry API (`mcp/registry.ts`, `GET /api/mcp/catalog?q=`): the Official MCP Registry and GitHub's, built
in, then up to eight the owner adds (`app_mcp_registries`). A registry is
added only once it answers `/v0.1/servers`, and removing it keeps the servers added from it. Search reads one page of
up to twenty entries per registry and keeps https streamable-HTTP remotes, rejecting entries explicitly marked
inactive or not latest. Missing status metadata is accepted. Results are labelled by registry, each server once
(the official registry first), and cached for ten minutes. Endpoint placeholders are filled with one safe path
segment each, and servers that require a secret header are listed but cannot be added yet. An added entry records
its registry, name and version. The owner connects each server from the Connections page:

1. `POST /api/mcp/:id/connect` first tries without sign-in. If needed, it runs the MCP SDK's `auth()` with our
   `StoredOAuthProvider`: discovery, dynamic client registration, PKCE. Only a flow needing consent returns a remote
   authorization URL; otherwise it returns `{}`.
2. The remote server redirects to `/api/mcp/oauth/callback`. The pending state is single-use and expires after ten
   minutes; the code is exchanged and the tokens stored.
3. Client registration and tokens are AES-GCM encrypted at rest (`GOBLIN_CREDENTIAL_KEY`, bound to server ID and
   purpose); discovery metadata is stored in plain JSON.

Credentials and grants belong to the endpoint they were made for (`mcp/endpoints.ts`, `app_mcp_endpoints`). When the
agent starts and a server ID now points at another endpoint, everything stored for it is dropped in one short
transaction: credentials, client registration, pending authorizations and grants. The owner connects and grants
again, so tokens issued by one host never reach another.

Calls go through the `McpConnectionManager`, keyed by server ID, which caches a connection and closes it after five
minutes idle. Its auth provider refreshes a token a minute before expiry, single-flight per server, and refreshes
once after a 401. A refused refresh marks the server `needs_auth` and the owner reconnects. Results are bounded (1 MiB,
16 MiB for App HTML).

Grants are per discovered tool (`app_mcp_grants`), toggled by the owner. A tool grant also grants its `ui://` App
resource. An App's switch (`PUT /api/mcp/app-grants`, `McpHost.setAppGrant`) grants an App as a whole: exactly the
tools that declare its `ui://` resource, including the ones only the App may call, and the resource itself.
Connections (`components/tool-grants.tsx`) lists those tools under the switch, each still adjustable, and offers Allow
all and None, which send the same exact grants one at a time. Tool annotations from the server are shown as its claims
("says read-only") but never grant anything. Disconnecting forgets credentials and keeps grants. When the model calls a tool that exists but is
not granted, nothing runs. `mcp_call` returns an error result whose details are
`{ kind: 'grant-required', serverId, name }`, and the model is told to wait.
`mcpModelResult` details never carry a top-level `kind`, so remote content cannot forge one. The web turns that
result into an owner-only Allow card. A conversation can switch servers and tools off for its agent (Capabilities,
above); that check comes first, and switches are forgotten with the server's grants.

## Skills

Skills come from MCP servers that declare the MCP Skills extension, and only from those the owner turns them on for
in Connections (`app_skill_sources`, ADR 0008). The client declares the extension; `McpConnectionManager.listSkills`,
`getSkill` and `readSkillFile` speak `skills/list`, `skills/get` and `resources/read`, with the shapes decoded in
`skills/protocol.ts` because the SDK has no Skills support yet. The current library activates entries from
`skills/list`; `getSkill` is available in the connection manager.

`SkillLibrary` (`skills/library.ts`) keeps each enabled server's listing for its `ttlMs` (30 s to an hour) and names
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
file reads; instructions already in a conversation stay there. A conversation can switch one library off for itself
(Capabilities): its section leaves the library out without fetching it, and its activations and reads are refused.

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
streams, the block whose fence is still open stays code (`lib/fences.ts`). A diagram is beautiful-mermaid's SVG as an
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
thread panel beside it at 75rem and wider, over its right side narrower, and as a full view of its own on a phone. The
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
text after the owner's words as a separate block shaped `{ origin: { serverId | app, trust: 'untrusted' }, appContext }`
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
then in the app's queue `run` reads the current state and returns the next, which is checked and committed as one
revision with the operation's receipt. A replayed operation id returns its receipt. The agent calls every app through
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
routes the view's action calls to `POST /api/apps/:id/call` with the frame's operation id (`ui:<app>:<uuid>`), and
reports the view's failures, which the agent sees in its `<apps>` list and in `app_inspect`. The frame's first script
keeps errors from before the core runs (a bundle that throws as it loads or never arrives), a view import whose bundle
failed names that bundle, a view module that throws shows the error card instead of a blank frame, and failures that
come together go out as one notice once the frame is connected (`packages/app/src/ui/core.ts`, `sdk.ts`). A bundle's
own message reads "Script error." because the frame is a different origin from the bundles. A new release reloads the
frame; a new revision is pushed into it. In the transcript the view shows under the newest build of it with one.
Inline agent app views have a borderless host surface and a quiet toolbar for page and close controls; the view
owns its canvas styling. External MCP Apps retain their framed host surface.

Beyond its state and files, an app reaches only the powers it declares and the owner approves (ADR 0021):
`ctx.fetch` to exact `egress` hosts (`agent-apps/egress.ts`: https on 443, never goblin's own domain, redirects checked
again, no cookies, bounded), and through the agent (`agent-apps/ports.ts`, connected in `compose.ts`) the owner's MCP
tools under their exact grants, the cheap model within the owner's budget, Telegram through their channel, and other
apps' actions and views (`agent-apps/engine.ts` composes each `prepare`'s `AppPowers`). Every use checks the approval
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
keep `kind = 'main'`. `ChatDirectory` answers `isConversation`, `topicOf`, `conversationOf(topic)` and
`conversationAbove(chat)`; `primary()` stays Personal's Conversation, where Telegram and inbound MCP clients land.

`TopicRegistry` (`topics/registry.ts`, the `Topics` service) creates a Topic with a new Pi session as its
Conversation, configured like Personal's (its tool filter and copied switches) but not forked from it. Create is
idempotent by operation id and serialized, so a retry or concurrent repeat finds one Topic and one Pi session; active
names are unique ignoring case (409). A Topic's Conversation is never renamed or closed directly and takes its Topic's
name. Branches, "+" threads (`CreateConversation.topic`) and subagents inherit their parent's Topic, and a "+" thread
announces itself in its Topic's Conversation. Archiving (`topics/program.ts`) marks the Topic and then stops each open
chat's work through the owner's Stop (runs, queued inputs, subagents and routine runs); its chats refuse new work
(`topic_archived`) until Restore, which restarts nothing. Personal is never archived. Schedules are untouched.

| Route | Purpose |
| --- | --- |
| `GET /api/topics` | Every Topic (`TopicView`), archived ones included. |
| `POST /api/topics` | `CreateTopic` (`{ name, operationId }`): a new Topic and Conversation, or the one that operation made; 201. |
| `PATCH /api/topics/:id` | `UpdateTopic`: rename, archive or restore, and the automatic-search opt-out; one new revision per change. |

All three are strict-CSRF browser writes and owner requests. The workspace feed's snapshot lists `topics`, a change is
`{ type: 'topic', topic }`, and each `ConversationView` carries `topic` and, for a Conversation, `conversation: true`.
Unit tests run the real migrations in `node:sqlite`; the local workerd owner case `topics-case.ts` runs in both
native profiles. Neither is deployed-stage evidence.

## Topic memory

Every Topic's Conversation (Personal's is Main) keeps its own memory (ADR 0032): `ChatMemory` (`memory/memory.ts`)
keys every row by chat id, and `ChatMemories` (the `Memories` service) gives each chat's (`of`), turns one on with
the `goblin.memory` and `goblin.recall` extensions (`activate`, once; composition activates every Conversation that
has none yet, and creating a Topic activates its Conversation) and forgets a moved turn (`truncate(chat, size)`).
Activation, entry reads and builder writes resolve the chat's current Pi session on each use, so a rebind moves no
memory row. The Builder document uses the generation API's `conversationId`; the builder works only for a
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

## Models

Each user picks the model their agent answers with, in the composer. The deployment offers `GOBLIN_MODEL_ID` (the
default) plus `GOBLIN_MODELS`, all served by the same LiteLLM key; `models.ts` names and groups them by route
(Google, Alibaba Cloud), because quota runs out per route. The pick is one row in `app_model_choice`; without one, or
when the deployment stops offering it, the default applies. Pi stores one model per conversation, set when it is
created, so before each turn the agent calls `session.setModel` for the conversation the turn runs in, skipping it
when that conversation already has the model. Every offered model is registered with
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
`GOBLIN_MODEL_CREDIT_RATES` (Gemini 3.8 Flash is priced as Qwen 3.8 Flash). The cheap model's calls (titles, memory,
skill drafts, an app's `llm` power) and routine runs (`routines/usage.ts`, from Pi's `pi.usage`) count the same way.
Compaction summaries in main and threads are not counted yet. Once the day is spent, new turns are refused with `BudgetExhausted`: HTTP 429 from the owner API,
or a tool error from `/mcp`. Telegram submissions check the same budget. Tool calls inside a running turn are blocked,
so a looping turn ends after one more reply. Pi reports and swallows exceptions thrown by hooks, so the in-turn lever
is blocking tools, not throwing. Settings shows today's usage, and the composer shows it as a ring, re-read whenever
a run ends. On wider screens the composer also
shows how full the context was at the latest response, measured against the model's `contextWindow`. The model key's
own cap stays the backstop.

## Resident authority

The agent acts for the owner when the owner is not there, so it needs its own standing permission rather than a
borrowed browser session. `ResidentAuthority` (`app_resident`) is active for 30 days. Owner RPC calls renew the window;
inbound calls and hooks do not. Turning it off in Settings ("Work while you're away") sticks: activity does not
re-enable it, only the explicit toggle does. Model MCP tools, skills, inbound `ask_agent` and scheduled Telegram pulls and replies require current authority.
Owner MCP RPC methods renew it but do not call `requireResident`; their tool/resource calls still check exact grants
(`agent.ts`, `pi/resident-mcp.ts`, `pi/skills.ts`).

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
  `inspect_turns`, `inspect_turn` and `inspect_problems`, with the contract's input and output schemas
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
advertises top-level `capabilities.events`, the action grants `inbox`, `send_message` and the exact Events selectors
`message.received` and `question.answered` with `{}` arguments. Both finite webhook subscriptions must confirm before
`app_telegram_channel` copies the checkpoint and fences old doorbell cursor writes. The channel pulls immediately;
a failure before that fence leaves the old channel checkpoint intact. A server without Events retains the legacy
`subscribe`/`unsubscribe` doorbell transport. Connections shows the active transport.

`POST /hooks/mcp-events/<userId>/<token>` verifies the user-bound token before lookup. Inside the object, Standard
Webhooks HMAC and five-minute freshness checks precede decoding. A pre-persisted subscribe intent accepts an early
signed verification challenge; remote ids are cross-checked when subscribe returns. Receipts and their frozen consumer
revisions commit in short transactions, with an already armed recovery schedule. The hook returns quickly and dispatch
runs asynchronously. Replay wakes unfinished handlers without duplicating their accepted intent.

`message.received` and `question.answered` both pull the authoritative inbox into the primary chat's current Pi
session. Telegram admission and answer readback use its operation ledger binding. `ask_user` ends its turn;
the answer arrives as the owner's next inbox message. The existing id mapping is preserved: `tg:123` becomes
`telegram-tg-123`, and reply operations keep their sanitization/truncation. Main's replies and subagent reports go
back with `send_message`, escaped and chunked, using `app_channel_replies`. Submission acceptance is distinct from
external Telegram completion. Disabling cleans up Events while authority is available, then tombstones locally;
finite remote leases expire if authorized cleanup cannot run.

The dispatcher also binds MySkills `skills.updated` and `skills.list_changed`. Their payload is untrusted metadata;
the handler persists a dirty catalog generation and invalidates the cache before acknowledgement. A listing can
clear only the generation it observed, and retained activations stay pinned. Gap controls trigger reconciliation;
termination stops lease refresh and surfaces health. Mail and workspace changes have no installed consumer yet.

The client refreshes before the producer's ISO `refreshBefore` and polls on gaps or webhook outages. Bounds are
32 subscriptions, 100 events per page, 256 KiB bodies, five-second remote requests and 10,000 pending rows / 32 MiB.
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
  prefix (`telegram-`, `routine-input:`, `subagent:`, …; anything else is `direct`, the owner or an MCP client). An
  unanswered turn keeps Pi's reason.
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
  `app_llm`), with tokens and errors (`memory/model.ts`).
- **Remote MCP steps** (`mcp.request`): every connect, tool call, skills request and Events request, with server,
  tool, outcome code (`UpstreamMcp:timeout`), expected blocked waits and duration (`mcp/log.ts`). Resident callers pass
  explicit conversation/task metadata, stripped before SDK dispatch; shared connection discovery is marked without
  attributing it to a turn. Reporter failures cannot change or retry the call.
- **Telegram** (`channel.received`, `channel.reply`): each inbox message by mygram id and its turn's operation id; each
  answer `sent` in pieces, or `given_up` after a day.
- An unexpected failure logs a fixed type and summary where it becomes `Internal` (`http/errors.ts`).

Each event goes to `app_run_events` (kept 30 days) and to one Workers Log line when it ends (`event: "run"`, its ids,
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

The benchmark measures its turns with the same pieces (`@goblin/runtime/telemetry`, `telemetry/benchmark.ts`):
`runTelemetry(storage, name, sinks)` gives the ledger, log and recorder for any object that runs Pi on its own SQLite.
Attach its `recorder` and await `recorder.restore(harness)` right after `Harness.open`, before enabling scheduling.
Pass a `CollectedRuns` sink to read events in process
(or read `ledger.forOperation(operationId)`), and `summarize(turn, events)` gives the per-turn numbers: attempts,
failures, tool calls and tokens. Attempt timing runs from the generation entering `request` to its assistant entry;
the first chunk is the first committed partial, so it is good to about 100 ms.

### Inspection

`Inspector` (`inspect/inspector.ts`, the `Inspect` service) reads the agent back without changing it or calling a
model. The queries are in `contracts/src/inspect.ts`:

- `conversations`: every conversation the agent keeps.
- `conversation`: a page of one conversation's Pi entries, oldest first, in full. Text is cut at 4000 characters and
  arguments or data at 2000, with `truncated` set. A leading author tag becomes `author`.
- `turns`: recent turns as one-line summaries (source, outcome, attempts, tool calls, failures, tokens). A chat filter
  resolves to its current Pi session; historical events keep their recorded Pi session.
- `turn`: one operation end to end. It joins Pi's own settlement of the submission (`done` with its answer entry, or
  `unanswered` with a reason) with every run event of the operation, in order, and `coverage` names what the
  timeline cannot show: a restart mid-turn, events still open, a missing final answer, or a compaction's model call.
- `problems`: events needing attention since a time (default the last day); expected authority waits and confirmed
  recovered model retries are filtered before applying the limit. Pass `all: true` for the full problem history.
  Cutoffs, empty answers and coverage gaps remain visible. Tool failures remain until reviewed; a successful turn
  alone never proves a failed tool recovered. Successful auxiliary model completions are excluded, including a
  `length` finish on a bounded memory call; actual auxiliary failures remain visible.

The agent answers them on its internal `/inspect` route as the RPC result shape (`agent-requests.ts`,
`inspect/request.ts`), which only `/mcp` calls, for a client that holds `goblin:inspect` (see Inbound MCP).

The agent reads itself too: main has a `diagnose` tool (`pi/diagnose.ts`, wired by `telemetry/agent.ts`), so the
owner can ask in Telegram why something failed. Without an operation id it returns the last day's problems and turns;
with one, that turn's timeline. Each event comes in a line (kind, status, timing, tool or model, error), never
content, and the result is marked untrusted because its private details can come from remote servers. It grants nothing. A conversation
that is not in `app_conversations` (a routine's run) has no entries page; its turns and events are still in the ledger.

## Storage

| Store | Tables | Owner |
| --- | --- | --- |
| Agent DO SQLite | `pi_*`, `cf_agents_*` and the other vendor tables | Pi, Agents SDK. Never touched. |
| Agent DO SQLite | `app_mcp_servers`, `app_mcp_registries`, `app_mcp_endpoints`, `app_mcp_credentials`, `app_mcp_oauth_pending`, `app_mcp_grants` | Drizzle: MCP metadata and authorization. |
| Agent DO SQLite | `app_resident`, `app_conversations`, `app_model_choice`, `app_usage_daily`, `app_metadata` | Drizzle: agent metadata and logical chat bindings (ADR 0030). |
| Agent DO SQLite | `app_chat_operations` | Drizzle: chat/operation admission intents pinned to their original Pi session, pruned opportunistically after 30 days (ADR 0030). |
| Agent DO SQLite | `app_conversation_capabilities`, `app_execution_exclusions` | Drizzle: conversation switches and helper app exclusions (ADRs 0010, 0029). |
| Agent DO SQLite | `app_chat_memory_log`, `app_chat_memory_nodes`, `app_chat_memory_state` | Drizzle: each Topic Conversation's memory, keyed by chat id (ADR 0032). `app_memory_log`, `app_memory_nodes` and `app_memory_state`, Main's agent-wide predecessors, were copied into chat `1` and are no longer read. |
| Agent DO SQLite | `app_topics` | Drizzle: the owner's Topics, each with its Conversation's chat id (ADR 0032). |
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
| D1 `goblinAuth` | `user`, `session`, `account`, `verification`, `jwks`, `rateLimit`, `oauth*` | Better Auth, `apps/runtime/migrations`. |
| D1 `goblinAuth` | `app_billing_accounts`, `app_billing_subscriptions`, `app_billing_inbox`, `app_billing_checkouts` | Drizzle: account payments and durable reconciliation. |

The withdrawn Members feature left dormant auth D1 tables and DO columns/tables. Applied migration files and keys
remain intact to preserve real data and migration history; the runtime no longer reads or writes that access metadata.
See [ADR 0014](adr/0014-members-and-workspace-authority.md) for the withdrawal.

Application tables are declared in `storage/schema.ts` and migrated inline in `storage/migrations.ts`.
`app_client_sessions` was dropped when inbound clients moved to main; it is not a current table.

Logical chat migration is additive: existing chat keys, capabilities, exclusions, titles, close/read marks and tree
parents stay in place. Pi entries, tasks, submissions, request ids and documents remain Pi-keyed, as do
`app_mcp_approvals`, MCP App call reads, `app_skill_activations` and `app_run_events`. `fork_entry`, `spawner_session`
and memory entry ids keep their original Pi identities. Routine reports, share-backs, thread-start notes and subagent
reports resolve the current target chat while its shared directory lock is held, then submit to Pi; passive write
acceptance starts no model turn and proves no external effect.

The chat layer has unit proof for lookup, operation retries, retention, CAS ownership and admission locks, plus a
local workerd profile that rebinds chat `1` to a fresh non-root Pi session in test subclasses before service
composition. Owner, helper, routine, channel and memory cases run under that profile; explicit owner and inbound
proofs assert the non-root session and an empty root transcript. The AST guard bans root constants, session-less
harness submission/session calls, and private `ChatDirectory` instances outside service composition and tests. These
prove local behavior; deployed-stage, live-provider,
Telegram-service and remote-eviction acceptance remain separate.

Better Auth lives in D1 because the Durable SQLite adapter's async transactions and affected-row semantics do not
meet its contract (ADR 0001). SQLite transactions are short and never span model or network calls.

## Infrastructure

`apps/web/alchemy.run.ts` declares the Vite Worker, the `PersonalAgent` namespace, the D1 database, the `FILES` R2
bucket and the `LOADER` Worker Loader (Dynamic Workers, open beta, Workers Paid); it is the only deployment
entrypoint. `scripts/stage.ts` builds `packages/app`'s toolchain before Alchemy runs. The local stage runs in workerd with CLIProxy; the dev stage calls Railway LiteLLM with a
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

`GET /api/billing/state`, `POST /api/billing/checkout` and `POST /api/billing/portal` authenticate the owner without
resolving an Agent. Product and checkout metadata are selected server-side. Checkout and the return page grant no
access: `POST /hooks/dodo` verifies Standard Webhooks HMAC over the raw body, checks freshness and stores the first
body under `webhook-id` before responding 2xx. A leased background run updates the subscription; an hourly Worker cron
retries unfinished receipts and reads stale subscriptions back from Dodo. Provider timestamps prevent old events
from overwriting newer states. This is durable idempotent reconciliation, not exactly-once provider effects.

Worker APIs, inbound MCP and user-bound hooks require an active plan before selecting the user's Agent. Agent owner,
client and background runs also check the shared `Entitlements` service. It reads current account state at admission,
without a cached plan or a lifecycle lock around D1/network waits. Pro is $10/month, without trial or free tier; active
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
shows the prompt, exact tool pairs, timezone, budgets and Telegram policy before confirmation.

Confirmed reminders and cron schedules use native dated Agent callbacks carrying routine ID, revision and firing
instant. A short application transaction claims each firing and advances its watermark before rearming; one newest
catch-up replaces missed slots, with a 24-hour window and one encrypted pending trigger while busy. Reconciliation
repairs missing schedules and removes only routine-owned wakes. The earliest-wake check considers future jobs only:
Agents includes the currently firing row in `listSchedules`, and counting it would suppress the next report/recovery
sweep. UTC reminders require an explicit offset. The
numeric cron parser enforces 15-minute spacing, skips spring DST gaps and chooses the earlier autumn repeated instant.

Pi background Anchor/Reporter tasks create and recover an empty task-owned run conversation, registered as a thread
without copied capability rows or an ordinary main-start note. The confirmed MCP ceiling narrows `Capabilities.scope`.
A dedicated per-run model provider checks resident authority, entitlements, deadlines and committed usage before
every model dispatch, including compaction. MCP checks repeat at the HTTP dispatch seam after token refresh, with
local correlation headers removed before egress. Main Stop leaves background runs alone; run Stop and archive fence
and abort owned conversations. Questions use sealed shared interaction receipts and authenticated same-session answers.

Committed `pi.usage` counters, including compaction, project into app-only cumulative watermarks and UTC-day
receipts: tokens for the routine's own caps, Credits for the owner's daily budget. Replay does not charge twice; a model response already in flight may overshoot a cap. Settlement freezes a
scrubbed summary and one `app.routine` parent write with a stable request ID. Telegram reporting is separate authorized
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

The runtime Home service, `/api/home`, tools, contracts and application tables remain active. Layout revisions, operation replay, owner authority and app-deletion cleanup still apply. Saved layouts and app state remain intact for a later UI iteration (ADR 0025). Layout edits currently have no visible browser surface; the agent's guidance says so and does not offer Home placement.
