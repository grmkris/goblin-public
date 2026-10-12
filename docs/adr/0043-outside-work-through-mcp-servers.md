# ADR 0043: Outside work comes through MCP servers, and some servers are first-class

showcase run with Sidequest (`evidence/handoffs/showcase-run-20261011.md`), where goblin could neither read a worker's
delivery page nor publish its own deliverable.

An agent that hires and works on a marketplace needs fresh information from the web, outside services it can pay for,
and a way to publish a page others can open. goblin has none of these: the model has no tool that takes a URL,
`code_run` has no network, an agent app may fetch only hosts the owner approved for it (ADR 0021), and nothing goblin
serves is public.

## Decision

**goblin gets outside work from MCP servers, not from tools of its own.**
- Search and paid outside tasks come from **Mercator** (`https://mercator.sh/mcp/auth`). It finds a service, quotes a
  plan for free and runs it as a paid job from the owner's Tempo wallet, which the owner limits when signing in.
- Publishing comes from the **Cloudflare API** server, signed in to the owner's own account: the agent publishes a page
  as a Worker there. The shelf advises Ask first for it.
- goblin's own instructions route fresh web data and outside tasks to Mercator, and ask the owner to connect it when it
  is not. A server's own `instructions` never reach the model.

**Mercator is a connection every account starts with**, configured by the deployment. It is still an ordinary
connection: the owner signs in, grants start empty, and the owner can sign out.

**A first-class server is one goblin knows by profile.** A profile is goblin's own description of a server it
supports, matched by endpoint, never by what the server says about itself:
- our title and description;
- a recommended set of grants the owner can apply in one tap (free tools run when needed, paid ones ask first);
- an optional status tool and the schema goblin reads its answer with (for Mercator: the wallet's balance, its
  remaining limit and when the period ends);
- an optional app tool that opens the server's own MCP App from its card;
- an optional spending argument for a paid tool (ADR 0044).

Mercator is the first; the owner's Agentic Wallet server joins when it exists, offered for top-ups when Mercator's
funding is blocked.

**What comes back is data.** A page, a search result, a job's result or a status answer is untrusted text with its
source (ADR 0003, ADR 0008). goblin decodes a status answer with its own schema, bounded, and shows it as the server's
claim. It never becomes an instruction and grants nothing.

## Rejected

- **A native fetch tool.** It would need its own egress rules, DNS pinning that Workers cannot do (ADR 0011), size and
  content limits and an approval surface, which a server the owner chooses already brings, with its own account.
- **Serving published pages from goblin.** A public page on goblin's origin would share the owner's session cookie
  origin; ADR 0022 keeps uploaded pages off it for that reason.
- **Trusting a server's self-description to make it first-class.** Anyone can claim a title; a profile is ours and is
  matched by endpoint.
- **Granting Mercator's tools on sign-in.** The owner applies the recommended set themselves, and sees what it allows.

## Consequences

- Without Mercator signed in, the agent cannot search or run outside tasks; it says so and a card offers to connect.
- What a job costs comes out of the owner's Mercator wallet, under the wallet's own limits and goblin's spending rules.
- A server the deployment configures cannot be removed, only signed out.
