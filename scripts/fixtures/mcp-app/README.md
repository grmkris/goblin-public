# Home MCP App browser fixture

No authentication, no remote connections, and no deployment. Install this fixture's pinned dependencies with
`bun install` in this directory, then `bun run start -- 18995`. The browser module is checked with its DOM environment using
`bun run check`; the server is checked by the root tooling project.

The official MCP Apps SDK supplies an in-memory counter, display-mode requests, context sharing and a tool call
whose arguments try to name another server. The host must keep that call bound to the origin. A browser acceptance
harness can serve this resource through the owner's routes with a controlled feed and grant state. Counter
continuity observes that inline, Home and page placements use one frame. Native runtime tests prove actual grants
and Home persistence separately.
