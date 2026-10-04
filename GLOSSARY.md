# Glossary

- **Owner**: the user an agent belongs to. Every signed-up user owns exactly one agent and sees only that one.
- **Agent / PersonalAgent**: the Cloudflare Agents SDK Durable Object that is a resident agent, named by its owner's
  user ID.
- **Pi Durable / PiHarness**: the conversation and execution runtime. It owns transcripts, tasks, recovery and tool
  replay; `PiHarness` is its native Agents SDK adapter.
- **Main thread**: Pi's root session. The owner's browser chat (and later Telegram) talk to it.
- **Client session**: a separate Pi session per inbound MCP client; it only ever sees its own messages.
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
