# ADR 0032: Topics and per-Topic memory

Accepted 2026-10-09 with the owner (Topics, round 4 of the spec). Builds on ADRs 0010, 0017 and 0030; the shell that
shows Topics is ADR 0036.

A Topic is a Slack-style channel: a durable container with exactly one Conversation and any number of Threads under
it. Personal is the default Topic, and today's Main (chat `1`) is its Conversation. Every other chat is a Thread of
some Topic. Telegram, inbound MCP clients and other channels still deliver into Personal.

## Stored shape

The additive migration `20261026000000_topics` creates `app_topics` (`storage/topics.ts`): id, name, the
Conversation's `chat_id` (unique), `archived_at`, `search_excluded`, `revision`, a unique `operation_id`, `created_by`
(`owner`, `agent` or `system`) and timestamps. A partial unique index keeps active names unique, ignoring ASCII case.
The migration inserts Personal (id 1, chat `1`, `system`) and adds `app_conversations.topic_id INTEGER NOT NULL
DEFAULT 1` with an index, so every existing chat joins Personal without a rewrite.

`app_conversations.role` names a chat's place: `primary` is Personal's Conversation (the inbound target),
`conversation` is another Topic's, `persona` is reserved for hidden Persona forks, and null is a thread, a subagent or
a routine run. A Topic's Conversation keeps `kind = 'main'`, because that column's CHECK cannot change additively.

## Directory roles

`ChatDirectory` (ADR 0030) answers the Topic questions from the same rows: `isConversation(chat)` (role `primary` or
`conversation`), `topicOf(chat)`, `conversationOf(topic)` and `conversationAbove(chat)`, the nearest Conversation up a
chat's parents (a loop in stored parents ends at its Topic's Conversation). `primary()` stays Personal's Conversation.
The conversation registry treats both roles as a channel: neither is renamed or closed directly (`main_thread` for
Personal's, `topic_conversation` for another's), and a Conversation's title is its Topic's name.

## Creating a Topic

`TopicRegistry` (`topics/registry.ts`, a store with no state of its own, behind the `Topics` service in
`topics/service.ts`) creates a Topic with a **new** Pi session as its
Conversation (`harness.sessions.create()`, then `configure` with an explicit extension list and Personal's tool
filter; Personal's switches are copied as a thread's are). It is not a fork of Personal: a Topic starts with none of
Personal's transcript. Create is idempotent by operation id and serialized by the service's per-key lock
(`KeyedLock`, key `topics.create`): a retry or a concurrent repeat returns the same Topic, and only one Pi session is
registered. The name is checked before the session is made,
so a clash (409 `Conflict`) leaves nothing behind. A crash between making the session and registering it would leave
one unregistered, unreachable Pi session; the retry registers a new one.

A Topic made from a discussion (the agent's organize tools) is created with a `TopicSeedData`: its
compact brief and at most eight frozen excerpts. The seed is a passive `app.topic_seed` write into the new
Conversation (request id `topic-seed:<operation>`, so a retry writes it once, and it starts no run); its model text is
the brief, then each excerpt in a block of its own labelled with its source chat and entries and as quoted history,
never as an instruction (`pi/content.ts` `topicSeedContent`). A Topic created in the owner UI has no seed.
`topic_create` (still only on the owner's direct request) takes an optional `brief` of at most 4,000 characters; called
from a chat, it seeds the new Conversation with that brief and one frozen excerpt (`topics/seed.ts`): the calling
chat's latest user message, as the entry range from it through the chat's newest entry, cut to 1,200 characters. A
call with neither a brief nor such a message writes no seed.

Threads inherit their Topic: a branch from any chat, an empty thread (`CreateConversation.topic`, under that Topic's
Conversation) and a subagent (its spawner's). A thread started empty announces its name to its own Topic's
Conversation. Routine runs stay in Personal.

## Archive and restore (v1)

Archiving marks the Topic (`archived_at`, new revision), then stops the work of its open chats through the owner's own
Stop: each chat's run and queued inputs, the subagents (Delegates) it started, and a routine run in it. Every chat is
stopped even if one fails, and asking to archive again stops them again. Schedules and routines are untouched. While
archived, a send to any of its chats, a branch from them and a new thread under it are refused (`topic_archived`).
Restore clears the mark and restarts nothing; it is refused while another active Topic has the name. Personal is never
archived (`personal_topic`).

## Owner API and feed

`POST /api/topics` and `PATCH /api/topics/:id` are the `topics` group of the owner API
(`packages/contracts/src/api/topics.ts`), served by the agent (`topics/api.ts`) behind the Worker's session, origin,
CSRF and plan checks; refusals answer in the API's error envelope. The Topics themselves are read from the workspace
feed (the list, `GET /api/topics`, had no other reader and was deleted on 2026-10-10). Archiving stops each open chat
through
`stopChat`, the owner's Stop. The workspace feed's snapshot carries `topics`, each change is a
`{ type: 'topic' }` item, and every `ConversationView` carries its `topic` and, for a Topic's Conversation,
`conversation: true`. An older client ignores all of these. A Topic write tells the agent's change bus
(`topics.changed`, ids only), and the feed reads each Topic as it is then.

Each create and archive records one content-free flow row (`topic_create`, `topic_archive` with how many chats it
stopped; ADR 0024): `replayed` for a repeat of the same operation, `refused` with the failure's type for a refusal.

## Per-Topic memory

Every Topic's Conversation keeps the long-lived summary memory Main has had (OptChat, `memory/`). The additive
migration `20261026000100_chat_memory` creates `app_chat_memory_log`, `app_chat_memory_nodes` and
`app_chat_memory_state`, keyed by `chat_id`, and copies Main's agent-wide `app_memory_*` rows into chat `1` with every
idx, entry id and node unchanged. The old tables stay, no longer read.

`ChatMemory(chat)` is the old `MainMemory` with every query keyed by chat id and the chat's Pi session resolved on each
use, so no memory row names a session. The `Memories` service serves them: `activate(chat)` (the `goblin.memory` and
`goblin.recall` extensions, once) and `truncate(chat, size)` (`forgetFrom` in `memory/store.ts`), which forgets the
messages from `size` on and every summary covering one, and pulls the view back to `size` at most; Move to thread uses
it.
Composition activates every Conversation without memory (a fresh agent's Personal, or a Topic whose activation a crash
cut short), and creating a Topic activates its Conversation, again on a retry with the same operation id.

The builder (`pi/memory.ts`) resolves its chat with `chatOf(conversationId)` and works only for a Conversation; a
thread or subagent remembers nothing of its own. Since 2026-10-09 the `Memories` service places a view as the chat's
passive write (`ChatOperations.passiveWrite`), under the chat's admission lock, so it never lands beside a send's
admission, and records how far it reaches only once the write was admitted; a failed write is placed again by the next
step. `zoom` reads the memory of the Conversation above its caller
(`conversationAbove`), bounded, in a thread, by its fork. `GET /api/agent/memory?chat=<id>` reports the memory of
that chat's Conversation, Personal's by default.

## Routines report to their Topic

The additive migration `20261026000500_routine_topics` adds `app_routines.topic_id INTEGER NOT NULL DEFAULT 1`. A
routine the agent drafts with `routine_propose` belongs to the Topic of the chat that called it (its Conversation or a
thread under it); one proposed through the owner API, and every earlier one, belongs to Personal. Its run
conversation is registered under that Topic's Conversation, in that Topic, and its `app.routine` report is a passive
write there. While the Topic is archived, archive v1 leaves its schedules running, so runs and reports go to Personal,
never out of sight; restoring the Topic brings them back. Stopping an archived Topic's chats stops a run already in
one of them.

## What needs the owner

`ConversationView.attention` lists what in a chat waits on the owner, for the web's Activity rail, from existing
sources only (`attention.ts`, no new storage): from the chat's own Pi entries, the asks since its newest user message
(an `ask_user` question, an `mcp_call` grant request, something switched off here), read from goblin's own tool-result
markers and never from a remote result (which carries an `origin`), as the web's cards are; from
`app_mcp_approvals`, the chat's held MCP calls still pending (by its current Pi session); and from
`app_agent_powers`, the powers the running release of an agent app living in the chat asks for and the owner has not
answered. Each item has its kind, when it began (seconds) and a bounded label; the entry for transcript asks. The
transcript part is read incrementally with the reply counts (`replies.ts`), so a quiet chat costs one empty read. A
chat's view is sent again when its run settles or the registry changes it; an approval or power answered elsewhere
shows on its next description.

## Inbound stays in Personal

`askClient`, Telegram turns and `recentOwnerMessages` resolve `primary()`, unchanged: every inbound channel lands in
Personal's Conversation, whatever Topic the owner used last.

## Verification

Unit tests (`test/topics.test.ts`, `test/chats.test.ts`) run the real migrations in `node:sqlite` and cover idempotent
and concurrent create with one session, case-insensitive clashes before any session, rename, archive, restore and
search revisions, Personal's protection and the directory roles. The local workerd owner case
(`test/integration/topics-case.ts`, in the ordinary and permuted-primary profiles) proves one Pi session per create,
409 on a clash, a reply in a Topic that Personal never sees, a thread that inherits its Topic and announces there, an
archive that aborts a held run and refuses sends, a restore that restarts nothing, Personal's protection, an inbound
ask landing in chat `1` and account isolation. Memory unit tests (`test/chat-memory.test.ts`) apply the copy migration
to seeded rows and check per-chat sizes and truncation; the local workerd case `native-topics.ts` (both profiles)
proves two Topics remember apart: the new Conversation's builder places its view only there, and Personal's memory
holds only Personal's messages, and that a routine proposed in a Topic runs under that Topic's Conversation and
reports there, never in Personal. None of this is deployed-stage or live-provider evidence.
