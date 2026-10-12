# 0053: Pinned services and Apps with a chat bar

Accepted 2026-10-12 with the owner. It amends ADR 0036 (Slack-style shell: the sidebar's services, an App's page),
ADR 0021 (agent apps: full screen with the chat) and ADR 0005 (the MCP Apps host: display modes), and builds on ADRs
0020 (kept Apps), 0034 (thread operations) and 0043 (a first-class server's App).

## Context

The sidebar listed every connected server with a global entrypoint under Services, on its own: the owner could fold
the section and nothing else. A server's App opened on a page of its own (`McpAppPage`) outside the Apps host: no
conversation, no residency, `share` dropped, fixed to fullscreen. An App's page (`/a/<id>`) had no composer, so the
owner left the App to talk about it. ChatGPT, which hosts the same MCP Apps, keeps its composer at the bottom of an App
full screen and opens global entrypoints full screen with a thread of their own.

## Decision

**Pins, synced.** The sidebar's Pinned section is the owner's ordered list of pins: a whole server (it opens the
server's own App) or one App view (one note, one drawing), mixed. They live in the agent's database as one revisioned
row (`app_sidebar`, its own migration, `sidebar/`), are read and changed through `GET` and `POST /api/sidebar`, and ride
the workspace feed (`sidebar` in the snapshot, a `sidebar` change), so every device follows at once. An edit names the
revision it was made from; one made from an older revision answers `stale` with the pins as they are, and the browser
makes it once more from those.

- **Pinned by default.** A connected server with its own App shows pinned until the owner changes the pins. The row
  keeps `seen`, the servers the sidebar has pinned on its own: an edit first stores the servers shown that way
  (`adopt`), so a server the owner unpins stays unpinned, and one that connects later is pinned once.
- **Kept clean.** Removing a connection (`mcp.removed`) takes its pin and forgets it; deleting an App
  (`apps.removed`) takes its view's pin. A pin of a server that is signed out hides until it is back, in its place.
- **Where.** Pin to sidebar and Unpin from sidebar are in a server card's menu, an App's page menu and the bar above an
  App in its conversation; each row's own menu has Move up, Move down and Unpin. At most 40 pins. Pinning grants
  nothing and opens nothing.

**One thread per server App.** Opening a pinned server, its card's Open or `/connections/<id>/app` makes once (or
reopens) the server's thread: an empty thread under Personal, its thread operation `server-app:<connection>`, named
after the server (`POST /api/apps/servers`). The server's App is kept in that thread like any App (marked
`entrypoint`), so it gets residency, `share`, model context, offers and grant asks through `AppHost`, and the thread
is listed under Threads. Its tool stays an owner call: the browser calls it as the owner on each open, on the panel
`?focus=` names (Start and the paid-job card's `focus=add_funds`), never read back from a transcript. Its one display
mode is fullscreen; it has no place in a transcript.

**Full screen keeps the composer.** An App's page fills the main column under the bar (Back to the conversation, the
App's name, its menu, Close), and goblin's composer for the App's conversation floats over its bottom edge, with the
agent's presence on it. The composer, and the line over it, are `data-app-cover`: the stage clips itself to them, and
the App is told what they cover as `safeAreaInsets.bottom` with `containerDimensions` the whole room. A reply goblin
finishes while the page is open shows as one line over the composer; a tap opens the conversation beside the App, or
in a sheet over its lower part on a phone, where the composer is the conversation's own. `ui/message` and
`ui/update-model-context` from the App go to that conversation, as everywhere. Inline stays as it was.

**No picture-in-picture.** The modes are inline and fullscreen, as ChatGPT kept them; Apps draw no mode buttons of
their own.

## Consequences

- A server App's thread holds the conversation about it; renaming or closing it is the owner's, and opening the App
  again reopens a closed one.
- The sidebar shows nothing pinned on a server older than this; the Services list it replaced is gone.
- The browser decides what is pinned by default from the server list, so a device that has not read the servers yet
  shows only the stored pins.
