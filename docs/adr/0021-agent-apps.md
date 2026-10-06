# ADR 0021: Agent apps

Accepted 2026-10-06 with the owner. goblin's agent could call tools and show servers' MCP Apps, but could not build
software for its owner. Spikes on 2026-10-06 proved the ingredients on Cloudflare: Dynamic Workers in the agent
object, live tool activation in Pi, sucrase in an isolate, server-side state with a queue, and low-end models building
working apps from a short reference.

**What an app is.** A small program the agent writes for its owner: `app.ts` (and up to five more files) exporting
`defineApp({ name, title, description, state: { schema, initial, migrate? }, actions, views })` from `@goblin/app`.
State is JSON, checked against its schema (the `s.*` subset of JSON Schema) on every change. An **action** is
`prepare` (effects, runs once, reads a snapshot) plus `run` (a pure reducer that returns the next state and may run
again); a **view** is `select` (read-only). Each action and view becomes one of the agent's tools.

**Agent-wide.** Apps belong to the agent, not to a conversation: their tools are offered in main and every thread.
Each has a home conversation, where it was first built. Subagents and routine runs keep their exact extension lists
and get no app tools in this version (ADRs 0012, 0018).

**Releases.** A build is a release, named by a hash of its sources and the toolchain. It becomes active only after
it transpiles, describes itself, passes the manifest checks, and the current state fits its schema or its `migrate`
makes it fit; otherwise it is kept as failed with its problems and nothing that runs changes. Activation snapshots
the state; `app_rollback` makes an earlier release active again, keeping the state when it fits and restoring that
release's snapshot when it does not. The last 20 retired and 10 failed releases are kept.

**Isolated execution.** Every release runs in a Dynamic Worker of its own over the agent's `LOADER` binding, with no
network, no bindings and a CPU limit; so do the transpiler and `code_run`'s one-off scripts. An app's powers come only
as an RPC target lent to one `prepare` call: in this version its own files (Shell's Workspace, namespace
`app_<name>`, 64 MiB) and a log line. This is the one place goblin runs code the agent wrote; skill scripts are still
never executed.

**Calls.** One path for every caller: check the input, return the receipt of a replayed operation id, run `prepare`
outside the app's queue, then in the queue run `run` on the current state and commit the checked next state as one
revision with its receipt. Tool calls use `c<conversation>:<call>` as the operation id and pin the release they began
on. goblin never claims exactly-once effects: `prepare` may repeat when a call is retried before its commit.

**Limits.** 16 apps; 12 actions and views each; 384 KB of source; state 1 MiB; input 64 KiB; what `prepare` hands on
or a view returns 256 KiB; tool results to the model 8 KiB; wall times 3 s to describe or migrate, 5 s to run or
select, 30 s to prepare; eight isolate calls at once.

**One registry.** Every App the workspace shows is a row of `app_registry` with a source: `mcp` (server, tool, `ui://`
resource and call, one per conversation and call, as ADR 0020 kept them) or `agent` (the app's name, one row per app).
The table replaced `app_apps`, whose rows it copied with their ids, so `a:<id>` panes, `/a/<id>` and stored layouts keep
working. The workspace feed's `AppView` and the launch say which source an App has.

**Views.** An app may have a UI: `view.tsx`, one React component drawn with goblin's components, the kit and Tailwind
classes. It is built with the release (transpiled to one CommonJS module, its classes compiled with goblin's theme in
an isolate of their own) and runs in the same double sandbox as an MCP App, as an opaque frame with no network that
loads only goblin's frame bundles. The view gets the app's state live, newest revision first, and changes it only
through the app's own actions, as the owner, with an operation id of its own; it calls no other app, no server and no
tool (an amendment of ADR 0005 for agent apps). Its failures go to the app's events, where the agent sees them in its
apps section; goblin does not write them into a conversation. Closing an agent app's view closes its stage and page
only; the app and its tools stay.

**Still to come** (the same plan, later milestones): powers beyond files (web fetch, the owner's MCP tools, model
calls, Telegram, other apps) with owner approvals; scheduled jobs; the Apps section and page, fullscreen with the chat
docked; owner deletion; sharing a view's context with the agent.

Consequences:
- Dynamic Workers are an open beta on Workers Paid; their pricing and limits may change.
- Local workerd enforces no CPU limit; only deployed isolates stop runaway code.
- A new or changed app changes the system prompt and the tools, which costs prompt-cache hits.
