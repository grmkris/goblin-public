# ADR 0020: Durable Apps, one iframe per instance

Accepted 2026-10-05 with the owner. Supersedes ADR 0005's one live App ("a second App replaces the first", the side
panel, the phone sheet and picture-in-picture) and ADR 0019's interim App pane. ADR 0005's sandbox, host context,
host-drawn offers and grant rules stand.

**An App is kept.** A call the owner's agent makes in an owner conversation to a tool that declares an App
(`_meta.ui.resourceUri`) keeps that App in the agent's registry (`apps/registry.ts`, `app_registry` since ADR 0021): one per conversation
and call, with its server, tool, `ui://` resource and title. *Show app* on an older call, or on one whose App was
closed, keeps it then (`POST /api/apps`), once the tool still declares that App. `GET /api/apps/:id/launch` reads the
call's arguments and its committed, redacted result back from the transcript. Closing a conversation closes its Apps.
The workspace feed carries Apps with the conversations. Keeping grants nothing: the resource and every call the App
makes still go through the owner's grants, live, and nothing stored (a kept App, a layout) brings a grant back.

**Several Apps live, one iframe each.** The browser host (`components/apps/host.tsx`) holds one instance per loaded
App, and each has its own stage in a fixed layer above the workspace, never moved in the DOM, since moving an iframe
reloads it. A stage follows its App's page while the App has one, otherwise its place under its tool row, frame by
frame. It springs between the two, and clips itself to what of that place shows: inside the containers that scroll
it, and under its pane's pill and composer. An App loads when its place comes on screen, in any conversation.

**Inline, or a page.** In its transcript an App is as tall as it asked, between 160px and 70% of the window. *Open as
a page* gives it a pane of its own (`a:<id>`, `/a/<id>`) beside its conversation, and its place there says so, with
*Go to it* and *Show here*. In its transcript the host's bar above the App names it and offers *Open as a page* and
×; on its page the pane's pill names it and its menu offers *Back in the conversation*, *Fill the workspace* and
*Close the app*, with no second bar. *Fill the workspace* maximizes that pane. That is fullscreen, and it is what an
App asking for fullscreen gets; asking for inline brings it back. The modes on offer are inline and fullscreen. On a
phone the page is one more pane in the strip.

**At most six loaded.** Beyond six instances the least recently seen unloads (`lib/app-residency.ts`). An App on
screen never unloads, so the cap is soft. An unloaded App's place shows a stub that loads it again.

**One Close.** The App's × closes it, as Close does for conversations (ADR 0017): its iframe and its page go, and its
tool row offers *Show app*, which keeps it again.

**Per conversation, in the sidebar.** What an App shares waits above its own conversation's composer and goes with
the next message there. The sidebar lists each open App under its conversation, and the rail shows the Apps open as
pages. Apps a conversation kept under one title (a tool called again and again) are numbered in order of creation,
closed ones counted, so names never shift; a conversation's row shows those open as pages and its newest three, and
folds the rest into "n more apps". App panes come back with a stored layout and load from the registry.

Consequences:

- [ADR 0025](0025-home-surface.md) records the deferred Home design. Current web placement is page > inline; saved Home layouts do not displace the canonical frame.
- Moving an App between its place and its page keeps it running. Reloading the page, unloading or closing it starts
  it fresh; an App keeps whatever state it wants to survive that itself.
- A call shown outside its own transcript (the message a thread branched from, above the thread) is a plain tool card.
- Live iframes cost memory: visible ones always load, and the cap bounds the rest.
