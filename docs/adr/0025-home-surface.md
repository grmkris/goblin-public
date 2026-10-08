# ADR 0025: Home surface

Accepted 2026-10-06. Web presentation deferred 2026-10-08 at the owner's request.

The decision below records the original design. Main now contains the transcript and composer; Apps use page > inline placement. The Home grid, navigation, pinning and edit UI are removed. Runtime layouts, operations and app state remain intact for a later iteration.

**Main has a desk below the conversation.** Home is a row after the newest exchange, inside the existing scroller and above the fixed composer. Threads and subagents have no Home. Main opens at its latest owner turn when that turn is today in local time; otherwise it opens Home. Now returns to that turn and the turn map's Home mark explicitly reaches the desk. Home is never a message anchor. Fixed size classes and opaque tiles keep loading and updates from moving the history reader.

**The layout belongs to the owner, beside Pi.** `HomeLayout` is an ordered, bounded list with a revision, stored in the agent object's application SQLite (`app_home` through Drizzle), separate from Pi's transcripts and each app's durable state. Order and size are shared; column count and edit mode belong to the device. Notes and recent conversations render in the host. Agent apps with a view may be placed. An owner may pin an open MCP App after the host launches it and rechecks the tool's declared resource; closing that App never blocks unrelated Home edits. There are no built-in metric or chart adapters.

**Figures are agent-made snapshots.** Note tiles use the chat figure renderer for Mermaid, map and chart fences, alongside ordinary Markdown, on the tile's flat card surface. Notes stay bounded at 4 KiB; figures should say when their data
was true. Live data uses scheduled agent apps with freshness and errors. Ask for a tile and the empty-state prompts
fill the composer without sending; edit mode offers the same action in a placeholder tile.

**An agent arranges what it placed.** `home_read` reads the layout and available agent-app ids. `home_edit` applies add, move, resize, update and remove atomically. Main and ordinary threads get these tools; routine runs and subagents do not. The agent can add and manage its own tiles immediately. Changing an owner-placed tile asks the owner instead. Each applied edit leaves a transcript receipt with Show and Undo. The owner uses the same service through Edit Home and keyboard tile menus. Presentation operations grant no connection, tool, power or credential.

**Concurrent and repeated intent is explicit.** Each write names its operation id and expected revision. A replay returns its stored receipt, while a stale revision returns the current layout without applying. Undo is a new owner operation that restores the prior layout only if no later edit intervened. Transactions are short and synchronous; none spans model calls or network waits. The workspace feed snapshots the layout and broadcasts the full committed layout on every change, so tabs need no polling. App erase removes its tile in the same operation.

**One frame follows three places.** Page > Home > inline is the placement order. `app-home:<id>` is an empty measured slot; the one iframe remains in its fixed stage and springs with PLACE between tile and page. Other places show compact stubs. The host exposes surface, tile size and fixed room through `useHost()` so a view can draw a glance variant. Tile height ignores resize requests; an unadapted view is clipped with a bottom fade and Open. Nearby tiles load lazily, the existing six-instance soft cap retains visible Apps, and dormant frames show fixed-size stubs.

**MCP App authority is explicit.** Only the owner can add an MCP App tile, through the same Home edit service used by
the UI. The owner path launches the App and verifies that the originating tool still declares its `ui://` resource
before the short layout transaction. Placement grants no server, tool or power. The browser keeps the App bound to its
originating server, and `/api/mcp/` writes use the same-origin CSRF guard. An agent can propose an agent-app tile, but
cannot pin an MCP App.

**Live external data belongs in an app.** An agent app can declare an exact MyInbox tool, validate and retain a bounded
newest-five snapshot in `prepare`, refresh it on a 15-minute schedule, and keep the last good data with a visible error.
Its Home view is a compact glance with freshness; the connected server id comes from Connections.

Remove from Home leaves the app alive. Close unloads its view and leaves Closed · Show; nothing silently reopens it. Show for an MCP App uses the keep-call POST to recheck its tool rather than the generic reopen PATCH. Upgrade and rollback reload the release in place while retaining placement. Context sharing keeps the registry-derived home conversation and existing untrusted-data boundary. No placement changes originating-server grants, opaque sandboxing, action authority or teardown.

Motion uses the house springs and pointer capture, interruptible position and release velocity; keyboard controls can do every drag action. Reduced motion uses 150 ms fades, reduced transparency keeps the dock solid, and the existing dock/safe-area inset clears the last row. A real-iPhone installed cold launch and touch check remains the owner's device acceptance, never a Chromium claim.
