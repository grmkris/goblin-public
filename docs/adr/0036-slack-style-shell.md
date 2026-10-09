# ADR 0036: Slack-style shell

Accepted 2026-10-09 with the owner (Topics round 4). Supersedes ADR 0019 (panes for everything) and what remained of
ADR 0016's layout, with their Trellis license and credit terms, which end with the dependency. Builds on ADRs 0017,
0020, 0021, 0029 and 0030; the runtime pieces it draws are ADRs 0032 to 0035.

**Three columns, as Slack has them.** A narrow moss-green rail of places: Home (the channels), then the app's other
places, and at its foot Apps, Connections, Settings and Sign out. Beside it a sidebar: the Topics as `#channels`
(Personal first, the archived folded), then the owner's agent apps. Then the channel: the Topic's one Conversation.
Personal is the first Topic, and its Conversation is Main, still `/c/1`. The message area is the warm off-white page;
the rail and sidebar are chrome, coloured by the `--shell-*` tokens of `@goblin/ui`, light and dark.

**Clicking a Topic opens its channel.** There is no Overview page and no Canvas tonight. Under each channel the
sidebar lists one flat level of its threads: at work, unread, recently opened or showing now. Add topic opens a dialog;
a new Topic opens its channel. The channel's `#name` is its menu (Rename, Exclude from search, Archive or Restore), and
an archived channel shows a banner with Restore where its composer was.

**Threads open in a panel beside the channel.** A message's Reply in thread opens a draft in the panel; the thread
exists once the draft is sent, because Pi cannot delete a conversation. Under the message a thread started from, a
summary reads "n replies · Last reply …" and opens it. Threads opened inside a thread stack in the panel with a back
crumb to the one under. The URL holds it: `/c/<channel>?thread=<id>` (with `stack=` only where the parents would not
derive the same back path, and `reply=<chat>-<entry>` or `reply=new` for a draft on top), so a reload, a link and the
browser's Back all work. A thread's or a subagent's own `/c/<id>` opens its channel with the panel showing it. On a
phone the panel is a full view over the channel with a reliable back to it. × closes the panel and stops nothing;
Close thread in its menu stops the thread's work, as before (ADR 0017). Share back is in the same menu.

**Who answers is visible.** Goblin's answers carry no name: Goblin answers unless the owner asked someone else. A
Persona's answer and a Delegate's result carry a mark, a name and what they are; Personas still answering show as
"answering…" rows. Start thread is a composer toggle (`POST …/threads`); Move to thread, in a message's toolbar, is
offered on the channel's newest finished owner turn. A strip under an answer names the other chats it used.

**The rail's places.** Threads (every thread, unread first), Activity ("Needs you": questions, approvals, grants,
App schedules, with organizing receipts and Undo) and Tasks (Delegates, Personas answering, routines) each carry a
count on the rail. Personas sit in the sidebar after the Topics; a click opens a profile page (`/p/<id>`) that edits
the definition and lists its revisions, never a direct chat.

**An App's page is the main column.** `/a/<id>` shows the App under a bar with "Back to #channel"; inline Apps stay in
their message's slot, and the one live instance (ADR 0020) springs between the two. The pane system's full screen with
a docked chat is gone: an App asking for fullscreen gets its page.

**No more panes.** Trellis, the pane store, the snapping strip, pane drag and drop, and the stored per-device
arrangement are deleted. What used to live in a pane's pill lives in the channel's bar or the thread panel's bar.

**What carries over.** The composer dock (approvals, questions and grant cards above the composer; attachments, the
model, usage, queued messages and per-chat capabilities in it), unread state and read marks, the presence orb, inline
MCP and agent Apps, Connections and Settings pages, and the one stream per chat (`lib/stream-pool.ts`).

**Ports.** Apps and composers ask the shell through `lib/navigation.ts` (whether an App shows as its page, open and
leave it, a new thread with a draft); the shell implements it over the router. A server without Topics, Personas or
the thread routes still works: Personal alone, and the parts of the UI that need the missing routes are hidden or off.
