# Native Pi runtime and identity storage

Accepted 2026-10-04 after the native stack spike. Outbound credentials, grants and the resident principal are
superseded by [ADR 0003](0003-resident-mcp-and-inbound-server.md).

`PersonalAgent extends Agent` uses `agents/harness/pi`. Alchemy declares the native class binding and owns one
TanStack Start Worker, its SQLite Durable Object namespace, static assets, and a separate D1 auth database.

Pi owns its transcript, task, submission, and recovery tables. Drizzle owns `app_metadata` and its migration journal
only. The application adds no competing transcript, task queue, or recovery engine.

Better Auth 1.7.6 uses `mcp()` plus `jwt()` on D1. The pinned Durable SQLite adapter's async transaction callback and
affected-row behavior cannot satisfy Better Auth's database contract. D1 is the smallest supported alternative;
its auth/grant tables do not become part of the Durable Object migration pipeline.

Owner sessions and inbound audience-bound OAuth tokens are distinct from outbound MCP credentials. The resident
agent accepts an owner session, stores safe session metadata, and rechecks live identity/grants before using tools.
MCP credentials and provider keys remain Worker secrets. Production promotion is outside this assignment.
