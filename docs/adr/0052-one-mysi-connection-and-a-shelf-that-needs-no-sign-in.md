# 0052: One mysi connection and a shelf that needs no sign-in

Accepted 2026-10-12 with the owner. The plan is `/tmp/goblin-mysi-usdc-subscription-plan-20261012.md` ("mysi as the one
connection"). It amends ADR 0006 (the shelf) and ADR 0009 (the Telegram channel's tool names).

## Context

The shelf offered five separate my* servers (MyPlan, MyTab, MyGram, MyInbox, MySkills), each with its own sign-in and
its own connection. mysi (mysi.lol) now fronts all of the owner's my* apps behind one OAuth and one MCP endpoint, and it
names every app's tools `<service>_<tool>` and, as it relays them, its Events `<service>.<event>`. One connection lists
about 130 tools. mysi is a product of its own with a free tier; it is not part of goblin Pro.

goblin's code still expected the old, bare names: the Telegram channel called `inbox` and `send_message`, which mygram
renamed to `inbox_read` and `message_send` on 2026-10-11, and the skill learner looked for `skill_draft` only.

The owner also wanted the shelf to offer servers that work with no sign-in, as long as they add something Mercator does
not already sell as paid jobs: web search (Exa, Brave, Parallel, Serper, Perplexity), scraping (Firecrawl), places,
flights, crypto, weather and Wikipedia.

## Decision

**One mysi suggestion replaces the five my* ones.** Its endpoint is `https://mysi.lol/mcp?codemode=off`
(`dev.mysi.lol` on local and dev): `codemode=off` keeps the full prefixed tool list under the same OAuth resource as
plain `/mcp`, which serves code-mode tools instead. A connection to the same origin and path counts as added whatever
its query.

**The shelf has groups** (`ServerSuggestion.group`), shown under their names in this order: `yours` (mysi), `goblin`
(Goblin Wallet, Cloudflare), then servers that need no sign-in by what they are for: `travel` (Kiwi.com, trivago,
Ferryhopper), `knowledge` (Wikidata, Microsoft Learn, AWS Knowledge, Hugging Face), `crypto` (CoinGecko, Etherscan's
keyless tier), `apps` (servers whose answers open as MCP App views: Excalidraw, SubwayInfo.nyc) and `code` (DeepWiki,
Context7, Cloudflare Docs, Svelte). A group whose servers all need no sign-in says so once.

**A server that needs no sign-in is shelved only where Mercator does not sell the same thing.** Exa and Firecrawl answer
without sign-in but stay off the shelf; Mercator sells search and scraping as paid jobs the owner's rules govern. Each
server that needs no sign-in answered an `initialize` with no credentials on the day it was added (recorded in
`mcp/suggested.ts`).

**Descriptions stay ours, and what servers say stays data.** Each suggestion's one line is goblin's. A server's
descriptions, annotations, `_meta` (mysi's `lol.mysi/suggest` hints included) and results are untrusted: they never
grant anything or become instructions. trivago's replies carry a `system_message` meant for the model; it is data
like any other result.

**Prefixed names are decided in one place.** `packages/contracts/src/service-names.ts` knows both spellings of an app's
tools and Events: the app's own (`inbox_read`, `message.received`) and mysi's (`mygram_inbox_read`,
`mygram.message.received`). The Telegram channel reads the spelling from the tools a connection lists and the Events its
`events/list` offers, grants exactly those names, keys its consumers by mygram's own event name, and resolves the send
tool from the live tool list for every later call (replies, notice copies, an app's `notify`, a routine's Tell me
scope, the web's Telegram switch). The skill learner drafts through whichever of `skill_draft` and
`myskills_skill_draft` the owner allowed. No legacy name (`inbox`, `send_message`) is kept: goblin is greenfield.

**`mcp_list` lists a large connection by service.** With more than forty tools whose names fall into services and no
filter, it answers each service (the prefix before the first `_`), its tool count and a few names, and tells the model
to call again with `service` or `query`; both filters also narrow any listing.

## Consequences

- An owner who added a my* server directly keeps it; the shelf just no longer suggests one. mysi decides which apps a
  connection reaches on its own consent page, and goblin's grants still start empty.
- The Telegram channel works over a direct mygram connection or a mysi one. Through mysi it needs mysi to advertise
  Events; until mysi relays them under `mygram.` names it passes mygram's own names through, and goblin follows
  whichever `events/list` offers.
- The doorbell transport remains for a server without Events, but no current server offers its `subscribe` and
  `unsubscribe` tools.
- The shelf's no-sign-in servers are third parties that may change or disappear; a failed connect is answered like any
  other, and the list is re-checked when it is next reviewed.
