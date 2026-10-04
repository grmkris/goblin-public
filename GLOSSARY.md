# Glossary

- **AG-UI** — Browser protocol used here to project committed agent state and reconnect from a fresh snapshot.
- **Agent / PersonalAgent** — Cloudflare Agents SDK Durable Object class that owns the resident lifecycle.
- **D1** — Cloudflare SQLite service used here for Better Auth sessions, OAuth clients, and MCP grants.
- **DO** — Durable Object; the `PersonalAgent` object provides durable per-agent storage and execution.
- **Pi Durable / PiHarness** — Pi conversation and execution runtime plus its native Agents SDK harness adapter.
- **Drizzle** — Application ORM used only for `app_metadata` and migration bookkeeping.
- **MCP** — Model Context Protocol; outbound servers are reached through an authenticated, capability-checked manager.
- **MCP App** — Sandboxed `ui://` resource rendered through its originating MCP connection.
- **LiteLLM** — Public Railway model gateway used by the retained Cloudflare dev stage.
- **CLIProxy** — Local model gateway used by coding agents and host-side tests.
- **Alchemy** — Infrastructure and local workerd orchestration library; the only deployment entrypoint.
- **Stage** — Named local, dev, or disposable test environment selected by `scripts/stage.ts`.
- **Receipt** — Stable operation record used to distinguish accepted submission from external completion.
