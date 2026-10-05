# ADR 0016: Workspace layout with Trellis

Accepted implementation decision, 2026-10-05. Its layout (the main stage, tabbed thread panes, sheets, `/t/:id` and
`?thread=`) is superseded by ADR 0019 (panes for everything); its license and credit terms carry over there.

Threads belong visibly to the main message they branch from: expanded inline previews show the first five own
messages, clipped text and quiet tool/thought summaries. Replies continue live while fewer than five exist; past that,
activity and the remaining count change. Collapse is a guarded device preference. The bounded owner API excludes
inherited main history. Empty owner-started threads get the same block.

A single side panel limits comparison between threads and an MCP App. At 75rem and wider the browser mounts
`@danfessler/trellis@0.3.0`, porting the necessary geometry and stable React portal-host pattern from MyPlan's pinned
adapter without runtime imports from that repository. Main is the stage view, never closable or floating. Threads
and drafts are separate panes; existing `/t/:id` routes and `?thread=` links remain valid. Narrow screens use thread
and App sheets. TanStack Start renders main alone on the server and mounts Trellis after hydration.

Version-1 pane metadata and layout are localStorage records scoped to owner and primary conversation on a device.
Malformed/future formats reset safely, legacy thread lists migrate, and disappeared or archived threads are pruned.
Drafts and App selections are ephemeral. A saved view never grants authority to restore an App. Reset layout keeps
current panes and equalizes their splits. Shadcn tokens theme Trellis in light and dark. Desktop thread panes use
the Trellis tab's title and close action; narrow sheets retain the full thread header, including the full-view link.

One live App remains the chat-view limit. Its nested opaque sandbox iframe and bridge stay in the fixed AppLayer
outside Trellis; only an empty slot moves. The stage measures that slot, hides for inactive tabs, and clips behind
higher floating windows without moving or remounting the iframe. Docking, undocking, resizing and crossing the narrow
breakpoint preserve the existing connection. A changed selection tears down and reconnects. Every App call still
uses the originating authorized server and current exact grants; arguments and saved layout cannot change it.
Fullscreen fills the workspace surface; narrow fullscreen retains the snapping bottom sheet. Owner grant and offer
flows remain host-drawn.

Trellis is commercially licensed. Dan Fessler gave Purrable permission to use it without sponsorship until Purrable
makes money, in exchange for crediting him and allowing him to showcase Purrable as a Trellis user. The workspace
toolbar and README credit him, linking https://github.com/DanFessler/trellis. This project-specific permission covers
the period before revenue; it does not mean sponsorship is already active.

Once Purrable earns revenue, Kris maintains an active GitHub Sponsorship at the applicable commercial tier. The
installed 0.3.0 `LICENSE-COMMERCIAL.md` specifies $10/month for individuals and $100/month for studios of up to 10
members. Larger organizations need an enterprise agreement. Sponsorship must stay active for continued commercial
use, with the required attribution; the library cannot be resold on its own or relicensed. The commercial license
and Dan's Purrable-specific permission remain the governing terms.

Reducer, migration, pruning and ported geometry tests cover persistence and main retention. Official MCP App SDK
interoperability tests prove originating-server binding across host-context updates and bridge reconnection. Local
Chromium interaction checks cover the real opaque iframe during layout moves and responsive fallback; deployed visual
acceptance is recorded separately in the lane status. These checks do not claim production deployment.
