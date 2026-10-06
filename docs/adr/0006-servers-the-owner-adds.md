# Servers the owner adds are a trust boundary, not a configuration change

Accepted 2026-10-04 with the owner.

**The owner may add MCP servers.** Until now servers came only from the stage's `GOBLIN_MCP_SERVERS`. Owners can now
add their own: by URL, or with one tap from a shelf we curate (`mcp/suggested.ts`, each entry checked to connect from
a Worker, with endpoints per stage and our own descriptions), or found in MCP registries that speak the generic
registry API (the Official MCP Registry and GitHub's). Added servers live in
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

**Same rules after adding.** An added server starts disconnected. Connect first tries the server without sign-in.
Many public servers need none, and some only offer it. If the server answers, it is connected with an empty token
the transport leaves out. If it refuses, the usual OAuth flow runs: discovery, dynamic registration and PKCE. A
server connected without sign-in that later refuses is marked `needs_auth`, and no OAuth runs in the background.
Grants are exact and default to none. Removing an added server forgets everything stored for it in one transaction:
its row, endpoint binding, credentials, client registration, pending sign-ins and grants. Configured servers cannot
be removed.

Consequences: a server that only accepts pre-registered OAuth clients cannot be connected, and Connect says so
rather than failing silently. Registry entries are labelled by registry and status, and they bring no more trust than
a pasted URL.
