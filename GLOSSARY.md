# Glossary

- **Owner**: the user an agent belongs to. Every signed-up user owns exactly one agent and sees only that one.
- **Agent / PersonalAgent**: the Cloudflare Agents SDK Durable Object that is a resident agent, named by its owner's
  user ID.
- **Pi Durable / PiHarness**: the conversation and execution runtime. It owns transcripts, tasks, recovery and tool
  replay; `PiHarness` is its native Agents SDK adapter.
- **Main conversation**: Pi's root session (`1`). The owner's browser and inbound MCP clients talk in it, each
  message from anyone but the owner's browser labelled with its author.
- **Thread**: a side conversation, branched from a message of main or empty. Nothing in it reaches main unless the
  owner shares it: `share_to_main` writes a note main sees and does not answer.
- **Subagent**: a conversation main or a thread starts with the `subagent` tool to do a job in the background; its
  answer comes back to the spawner as an input labelled with its name.
- **Memory view**: main's memory as the model reads it: an `app.memory` entry of one-line summaries (48 KB) that
  starts main's context, followed by the newest exchange verbatim. `zoom` opens a line.
- **Memory model**: `PURRABLE_MEMORY_MODEL`, the cheap offered model for housekeeping (thread titles, main's memory);
  its tokens count toward the budget.
- **Conversation registry**: `app_conversations`, the conversations a request may open (main, threads, subagents).
- **Resident authority**: the agent's own permission to use the owner's MCP connections when the owner is not
  present. Lasts 30 days, renewed by owner activity, revocable in Settings.
- **Outbound MCP server**: a server the agent calls (MyPlan, MyBrowser), listed in `PURRABLE_MCP_SERVERS` and
  connected by the owner through OAuth.
- **Grant**: the owner's per-tool permission for one outbound server. A tool grant also covers its `ui://` App.
- **Inbound client**: an MCP client (Claude Code, another agent) the owner authorized to call Purrable's `/mcp`.
- **MCP App**: a sandboxed `ui://` resource rendered inline through its originating MCP connection.
- **Operation ID**: the stable key that makes a submission idempotent. Acceptance is not external completion.
- **Model budget**: tokens a user's agent may spend per UTC day; past it, new turns get 429 and tools are blocked.
- **Sign-up mode**: `open`, `invite` (an invite code is required) or `closed`; deployed stages default to `closed`.
- **D1**: Cloudflare SQLite holding Better Auth's tables only (users, sessions, inbound OAuth clients and tokens).
- **CLIProxy / LiteLLM**: model gateways. CLIProxy for local work on the build box; Railway LiteLLM for the deployed
  dev Worker, with a dedicated capped key.
- **Alchemy**: the only infrastructure and local-workerd entrypoint. **Stage**: `local`, `dev` or a disposable
  `test_*` environment selected by `scripts/stage.ts`.
