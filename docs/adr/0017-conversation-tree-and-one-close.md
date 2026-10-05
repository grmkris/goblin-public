# A tree of conversations, threads from anywhere, one Close

Accepted 2026-10-05 with the owner. Supersedes ADR 0007's "threads do not branch further", its archiving and its
`share_to_main`; amends ADR 0010 (a new thread copies its parent's switches, not main's).

**Conversations form a tree.** `app_conversations.parent_session` is where each conversation came from: the
conversation a thread branched from (main for one started empty with "+") and the spawner of a subagent. Main is the
root and the only conversation without a parent. The registry walks it in SQLite (a recursive CTE whose `UNION` ends
even on a cycle), so depth costs nothing and nothing caps it.

**Threads branch from any open conversation, at any depth.** `POST /api/conversations` with
`{ from: { conversation, entry } }` forks that conversation at one of its messages (`pi.user` or `pi.assistant`):
- The fork is made a thread: the host's extensions plus the thread's, with a subagent's own selection and instructions
  dropped, so a thread from a subagent is the owner's thread with `ask_user` and subagents.
- It copies the switches its parent works under (a subagent's are its spawners'); Reset copies them again.
- `recall` reaches as far into main's memory as the thread saw main: up to the fork for a branch of main, never further
  than its parent for a deeper branch, nothing for a thread that never saw main.
- A thread from a subagent marks that subagent kept open (`keep_open_at`), for when subagents close themselves.

`share_back` replaces `share_to_main`: the note goes into the conversation the thread branched from, as before a
passive Pi write that starts no run.

**One Close replaces Archive, for threads and subagents alike.** Closing stamps the conversation and every open one
under it (`closed_at`, `closed_by: 'owner' | 'done'`) in one statement, then aborts each across background boundaries
(Pi `abort({ background: true })`): its run, its queued inputs and its reporters, so a closed subtree runs nothing. A
live routine run in it is settled as stopped by the owner first. A closed conversation stays readable and refuses new
messages; Reopen opens only the one asked for. Main never closes. The migration copies every `archived_at` into
`closed_at`, and nothing reads `archived_at` any more.

Stop in a conversation also stops the subagents it started, through subagents of subagents, but not the threads
branched from it: those are the owner's own.

**The workspace is one live feed.** `GET /api/workspace/events` (owner only, like every conversation route) sends a
`WorkspaceSnapshot` (every conversation, and what each that is not idle is doing), then batches of `WorkspaceChange`:
a conversation as it is now, or its activity. Activity comes from Pi's task graph while someone listens: `working`
while a conversation has ordinary work, `waiting` while only a reporter waits there on a subagent. When a conversation
goes idle it is described again (its replies and its title may have changed). `ConversationView` no longer carries
`busy`; one feed per tab replaces polling the list after every run.

Consequences:
- The thread routes are now `/api/conversations*`; the list (`GET /api/conversations`) stays for scripts and tests.
- Unlimited depth is bounded only by the owner's budget until subagents v2 (Phase 5 of the panes plan) adds closing on
  report; Close and Stop reach the whole subtree, and the feed shows a subtree that is still waiting.
- Activity lives in the Agent's isolate: a client that reconnects starts again from a fresh snapshot.
