# The agent object owns MCP, holds its own authority, and serves /mcp

Accepted 2026-10-04 with the owner. Supersedes the outbound-credential and grant storage parts of ADR 0001.

**Outbound MCP lives in the agent object.** The first slice called MCP servers from the Worker with static access
tokens bound as secrets (about an hour of life, refresh meant redeploying) and kept grants in D1. Now the
`PersonalAgent` Durable Object owns connections, credentials and grants. The owner connects each server through
OAuth (discovery, dynamic registration, PKCE) from the app. We implement the MCP SDK's `OAuthClientProvider` over
encrypted DO storage and keep our own connection manager, so refresh happens in one place, single-flight per server:
concurrent refreshes with rotating refresh tokens would otherwise invalidate each other. D1 is Better Auth only.

**Grants are per tool.** The owner ticks discovered tools; nothing is granted by default, and a tool grant covers its
App resource. Server-supplied annotations are displayed as claims and never grant anything.

**The agent has resident authority instead of a borrowed session.** The agent must act while the owner is away (and
later on a schedule), so it cannot depend on a live browser session. Authority is a DO-local record, active for 30
days, renewed by owner activity, and revocable; revocation is sticky until the owner re-enables it. Every outbound
call checks it.

**Purrable is an MCP server.** Better Auth's `mcp()` plugin is the authorization server for `/mcp`. Registration is
open because MCP clients register themselves, but it can only target `/mcp` and every client needs the owner's
consent. Each inbound client gets its own Pi session and sees only its own messages. Tools are `ask_agent` and
`get_recent_messages`; anything broader waits for a concrete need.

**Streaming is Pi-native.** The browser reads committed Pi entries over SSE (snapshot, then batches); the AG-UI
translation layer was dropped because nothing else consumed it.

Consequences: `PURRABLE_CREDENTIAL_KEY` is required and rotating it means reconnecting servers. A refused refresh
shows the server as needing authorization rather than failing silently. Exactly-once external effects are still not
claimed: `mcp_call` is unsafe to replay and submissions carry operation IDs.
