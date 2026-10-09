# Glossary

- **Owner**: the user an agent belongs to. Every signed-up user owns exactly one agent and sees only that one.
- **Agent / PersonalAgent**: the Cloudflare Agents SDK Durable Object that is a resident agent, named by its owner's
  user ID.
- **Pi Durable / PiHarness**: the conversation and execution runtime. It owns transcripts, tasks, recovery and tool
  replay; `PiHarness` is its native Agents SDK adapter.
- **Main conversation**: Pi's root session (`1`). The owner's browser, inbound MCP clients and Telegram talk in it, each
  message from anyone but the owner's browser labelled with its author.
- **Thread**: a side conversation, branched from a message of any open conversation (main, a thread, a subagent) or
  empty under main. Nothing in it reaches its parent unless the owner shares it: `share_back` writes a note there that
  the parent sees and does not answer.
- **Close**: what the owner does to a thread or subagent instead of deleting it: it and everything under it stop and
  take no messages, stay readable, and Reopen brings one back. Main never closes.
- **Workspace feed**: `GET /api/workspace/events`, one SSE stream per tab with every conversation and what each is
  doing (`working`, or `waiting` on its subagents).
- **Channel**: a Topic's one Conversation as the web shows it (`/c/<id>`, ADR 0036), `#` and the Topic's name in the
  sidebar. Personal's channel is Main.
- **Thread panel**: where the web shows a thread beside its channel (a full view on a phone), threads opened inside it
  stacked with a back crumb. Closing the panel leaves the thread going; Close thread stops it.
- **Read mark**: when the owner last saw a conversation's newest reply (`read_at`), kept by the server so every
  device agrees what is unread.
- **Subagent**: a conversation main or a thread starts with the `subagent` tool to do a job in the background; its
  answer comes back to the spawner as an input labelled with its name.
- **Memory view**: main's memory as the model reads it: an `app.memory` entry of one-line summaries targeting 48,000 bytes that
  starts main's context, followed by the newest exchange verbatim. `zoom` opens a line.
- **Memory model**: `GOBLIN_MEMORY_MODEL`, the configured offered model for thread titles, main's summaries and
  skill-draft decisions. Unset or not offered uses the default; its tokens count toward the budget.
- **Telegram channel**: the one myagent connection that carries Telegram for the agent (ADR 0009). Owner messages
  arrive in main authored "Telegram", on a signed **doorbell** from myagent; answers go back with `send_message`.
- **Conversation registry**: `app_conversations`, the conversations a request may open (main, threads, subagents).
- **Resident authority**: the agent's own permission to use the owner's MCP connections when the owner is not
  present. Lasts 30 days, renewed by owner activity, revocable in Settings.
- **Outbound MCP server**: a server the agent calls, configured in `GOBLIN_MCP_SERVERS` or added by the owner by URL,
  suggestion or registry. Connections tries without sign-in first, then OAuth if needed.
- **Grant**: the owner's per-tool permission for one outbound server. A tool grant also covers its `ui://` App.
- **Capabilities**: what one conversation lets its agent use (ADR 0010): the owner's grants, skills libraries and
  subagents, narrowed by what was switched off there (`app_conversation_capabilities`). A new thread copies main's
  switches; a subagent is bounded by every conversation above it. Switches only narrow; they never grant.
- **Files**: the owner's files (ADR 0022): `/uploads`, what they uploaded or attached to a message, and `/agent`, what
  the agent wrote. Kept in the agent's SQLite through Shell's Workspace, larger ones in R2; the agent writes only
  `/agent`.
- **Attachment**: a file the owner sent with a message: its path rides with the words, and the message shows it.
- **Agent app**: a small program the agent wrote and goblin runs (ADR 0021): durable JSON state, actions and views
  that are the agent's tools (`app_<name>__<member>`), its own files. Not an MCP App, which a server serves.
- **Release**: one build of an agent app, named by a hash of its sources and toolchain; one is active, earlier ones
  can be rolled back to, failed ones keep their problems.
- **Revision**: the number of an agent app's state, one more with every change an action commits.
- **Power**: something an agent app reaches beyond its state and files (a host, an MCP tool, the model, Telegram,
  another app); it declares it, and the owner approves it.
- **Schedule** (job): an agent app's action that runs on its own, every 15 minutes to daily, on a native schedule.
- **Block**: a fenced `mermaid, `chart or ```map block in the agent's reply, drawn in place (ADR 0023).
- **Kit**: `@goblin/kit`, the one implementation of the drawn blocks, for the chat now and agent apps later.
- **Inbound client**: an MCP client (Claude Code, another agent) the owner authorized to call goblin's `/mcp`.
- **MCP App**: a sandboxed `ui://` resource served through its originating MCP connection. One live App moves between
  its place in the transcript and its page (`/a/<id>`) while its iframe stays in place.
- **Skill**: a procedure (`SKILL.md` and its files) served by an MCP server through the MCP Skills extension. The agent
  lists and follows skills only from servers the owner turned skills on for; it activates them for a conversation, by
  handle `<server>:<name>`, and a skill never grants a permission (ADR 0008).
- **Skill draft**: a skill the agent proposed to the owner's skills library (MySkills) after a correction; the owner
  accepts or rejects it there.
- **Operation ID**: the stable key that makes a submission idempotent. Acceptance is not external completion.
- **Model budget**: estimated Token Plan Credits a user's agent may spend per UTC day (ADR 0026); past it, the owner submit API returns 429, inbound
  `ask_agent` fails and tools inside a running turn are blocked.
- **Sign-up mode**: `open`, `invite` (an invite code is required) or `closed`; deployed stages default to `closed`.
- **D1**: Cloudflare SQLite holding Better Auth's tables only (users, sessions, inbound OAuth clients and tokens).
- **CLIProxy / LiteLLM**: model gateways. CLIProxy for local work on the build box; Railway LiteLLM for the deployed
  dev Worker, with a dedicated capped key.
- **Alchemy**: the only infrastructure and local-workerd entrypoint. **Stage**: `local`, `dev` or a disposable
  `test_*` environment validated by `scripts/stage-config.ts`; `scripts/stage.ts` selects local or dev.
