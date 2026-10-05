# ADR 0019: Panes for everything

Accepted 2026-10-05 with the owner. Supersedes ADR 0016's layout: the main stage, tabbed thread panes, thread and App
sheets, `/t/:id`, `?thread=` and Reset layout. ADR 0016's Trellis license and credit terms carry over below.

**Every conversation is an item in a pane of its own.** Main, a thread, a subagent, a thread's unsent draft and the
transcript's App are items (`c:<id>`, `d:<conversation>:<entry>` or `d:new`, `a:<id>`), and each is shown in exactly
one pane with no tabs. Opening an item that is already open focuses it. Main is closable like any pane; only the last
pane cannot close. Closing a pane never closes its conversation (that is the conversation's own Close, ADR 0017).

**A floating pill replaces the tab.** Each pane draws its own header over the top of its transcript: a grip to drag
it, where it came from (the conversation a thread branched from, a subagent's spawner, which opens beside), its name
with a menu (Rename, Share to *parent*, Fill the workspace, Close or Reopen), what it is doing, and × to close the
pane. The first pane in reading order also offers the sidebar; on a narrow screen every pane does.

**Where things open.** A sidebar click shows the conversation in the focused pane. A link in a transcript, a crumb,
Open thread and Reply in thread open beside the pane they came from. Dragging a pane's grip onto another pane splits
it at the edge it is dropped near (a split that would leave a half under 320×240 is refused, except sideways) or, in
the middle, opens there, trading places when the dragged item is already open. Escape cancels. Every structural
change re-balances: each column of a row is as wide as the others.

**The URL names only the focused conversation** (or, since ADR 0020, App: `/a/<id>`), `/c/<id>`, replaced as focus
moves so Back leaves the workspace rather than stepping through panes; `/` restores the device's focus. A deep link
opens its item beside the focused pane. The arrangement is a device preference in localStorage
(`purrable:workspace:v2:<owner>`), a bounded Trellis document of one-view panes (64 views, 128 KB, no stage, nothing
floating). Conversation and App panes come back; drafts do not, since they need what the owner did this time. A
stored layout never grants anything.

**Desktop and narrow screens.** At 75rem and wider, Trellis 0.3.0 lays out the panes after hydration as a controlled
document: the store's document goes in, divider resizes and focus come out, and nothing else of Trellis is used (no
tabs, menus, floating, navigation or shortcuts). When the panes need more than about 400px each, the layout scrolls
sideways and a newly focused pane scrolls into view. Narrower screens show one pane at a time in a strip that snaps
pane by pane; the pane in view is the focused one. Each item renders once into a stable host that moves between
panes, the strip and a parking lot, so React state and streams survive every rearrangement. Fill the workspace shows
one pane alone until the next change.

**The sidebar is the tree, and folds to a rail.** Main with its subagents (at any depth), then the threads, each with
everything under it; closed conversations fold into "n closed" under where they sat. A row shows its agent's working
time, work going on under it and unread replies, shows here on a click, opens beside from its side button and drags
onto a pane like a grip. On a desktop the sidebar folds to a 56px rail, never further: main and the conversations that
are open, at work or unread, each icon shaped by kind, marked when focused or open, with a hover card saying what it
is, where it sits and what a click does. Unread is synced through the server, not per device: `read_at` on
`app_conversations` is the owner's read mark (`PUT /api/conversations/:id/read`), set once a pane has shown the
conversation for a moment, and replies after it are unread.

**Apps.** An App is an item too (`a:<id>`): its page, in a pane of its own. ADR 0020 (durable Apps, one iframe per
instance) replaced the interim single App pane this decision first shipped with.

Trellis is commercially licensed. Dan Fessler gave Purrable permission to use it without sponsorship until Purrable
makes money, in exchange for crediting him and allowing him to showcase Purrable as a Trellis user. The workspace
toolbar and README credit him, linking https://github.com/DanFessler/trellis. This project-specific permission covers
the period before revenue; it does not mean sponsorship is already active.

Once Purrable earns revenue, Kris maintains an active GitHub Sponsorship at the applicable commercial tier. The
installed 0.3.0 `LICENSE-COMMERCIAL.md` specifies $10/month for individuals and $100/month for studios of up to 10
members. Larger organizations need an enterprise agreement. Sponsorship must stay active for continued commercial
use, with the required attribution; the library cannot be resold on its own or relicensed. The commercial license
and Dan's Purrable-specific permission remain the governing terms.

The workspace toolbar is gone with this decision, so the in-app credit moved to the sidebar footer, with the same
text and link; the README keeps its credit.

The pane store (`lib/workspace.ts`), the one-view geometry (`lib/trellis-layout.ts`), drop planning
(`lib/pane-drop.ts`) and bounded parsing (`lib/workspace-document.ts`) are pure and unit-tested. A local Chromium run
against local workerd covers opening, drafts becoming threads, nested threads, Close and Reopen, closing main, the
last-pane rule, sidebar and deep links, reload, drag to split and swap, Escape, fill and the narrow strip. The tree
and rail (`lib/workspace-tree.ts`) are unit-tested, and the read mark's round trip through the workspace feed runs in
local workerd.
