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

**Powers and approvals.** Beyond its state and files, an app reaches only what it declares (`egress` hosts, and
`uses`: the owner's MCP tools as `<server>/<tool>`, other apps, model calls, Telegram) and the owner approves. A
release that asks for powers still becomes active; its build result carries the ones waiting, which the web shows as
a card under the build, and the agent's apps section lists them. A power is checked when it is used, in `prepare`
only: approved and not revoked, within the app's daily caps (2,000 fetches, 20,000 model tokens, 10 notifications),
and through the agent's own authority (the owner's plan and current resident authority; an MCP tool also needs the
owner's exact grant). Fetches go only to exact approved hosts over https on 443, never to goblin's own domain, with
redirects checked again, no cookies, 20 a call and bounded sizes and time. Apps call apps at most three deep. What an
app brings in from outside is data: its tool results say so once it can reach out. The agent cannot approve; the owner
answers on the card (`PUT /api/agent-apps/:name/powers`).

**Downloads.** A view offers the owner a file (`download()`, MCP Apps' `ui/download-file`); the host draws it with a
Save button and saves nothing without the owner's click.

**Finding servers.** `mcp_suggest` searches goblin's suggested servers and the owner's registries (results are
untrusted data), and `mcp_request_server` asks the owner to add one: a card with its name, address and the agent's
reason, trusted only from that tool's own result, whose Add and connect runs the usual add and sign-in flow.

**Schedules.** An app runs an action on its own with `schedules` (`every` 15 minutes to a day, a daily one `at` a
UTC time; at most four, one per action, the input checked against the action's). Each is one row in
`app_agent_jobs` and one dated native schedule of the agent object (`runAppJob`), armed for the next slot and
reconciled when a release activates or rolls back and when the object starts. A job is a call like any other, with
the operation id `job:<app>:<action>:<slot>`; it asks no model unless the action does. A late run catches up only
the newest missed slot. At most two jobs run at once per agent and 96 a day per app. A failure waits 15 minutes,
doubling to six hours, and ten in a row pause the schedule until a new release. While the owner's plan or resident
authority lapses, runs are skipped and recorded as waiting. The feed carries each schedule's state; the App's bar
shows it, and the agent's apps section lists it.

**Still to come** (the same plan, later milestones): the Apps section and page with pause, resume and run now,
fullscreen with the chat docked; owner deletion; sharing a view's context with the agent.

Consequences:
- Dynamic Workers are an open beta on Workers Paid; their pricing and limits may change.
- Local workerd enforces no CPU limit; only deployed isolates stop runaway code.
- A new or changed app changes the system prompt and the tools, which costs prompt-cache hits.
