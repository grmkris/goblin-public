# Servers the owner adds are a trust boundary, not a configuration change

Accepted 2026-10-04 with the owner.

**The owner may add MCP servers.** Until now servers came only from the stage's `PURRABLE_MCP_SERVERS`. Owners can now
add their own by URL, and a later change adds them from a curated shelf or from MCP registries. Added servers live in
the agent object (`app_mcp_servers`) beside the configured ones. Configuration wins on a server ID; added servers get
IDs of their own (host slug plus a random suffix) and can never shadow a configured one. Each agent may add sixteen.

**Only public https endpoints.** An added endpoint must be https, carry no credentials or fragment, and name a public
host. IP literals, `localhost`, single-label names and private suffixes (`.local`, `.internal`, `.lan`,
`.home.arpa`) are refused. Workers cannot reach a private network anyway, but the rule keeps the intent explicit and
the error clear.

**What a server says about itself is a claim.** Its server card (`/.well-known/mcp/server-card.json`) is fetched once
when it is added: bounded, decoded and timed out. Its title and description label the server for the owner, shown
as the server's own words. They never reach the model and never grant anything. Its icon is stored but not loaded,
so a publisher does not learn when the owner opens Connections.

**Same rules after adding.** An added server starts disconnected. Connect runs the same OAuth flow (discovery,
dynamic registration, PKCE). A server that publishes no OAuth metadata is tried without sign-in. If it answers, it
is connected, with an empty token the transport leaves out, and a later demand for sign-in marks it `needs_auth`.
Grants are exact and default to none. Removing an added server forgets everything stored for it in one transaction:
its row, endpoint binding, credentials, client registration, pending sign-ins and grants. Configured servers cannot
be removed.

Consequences: a server that only accepts pre-registered OAuth clients cannot be connected, and Connect says so
rather than failing silently. Registry entries are labelled by registry and status, and they bring no more trust than
a pasted URL.
