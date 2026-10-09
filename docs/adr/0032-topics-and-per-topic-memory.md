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

`TopicRegistry` (`topics/registry.ts`, the `Topics` service) creates a Topic with a **new** Pi session as its
Conversation (`harness.sessions.create()`, then `configure` with an explicit extension list and Personal's tool
filter; Personal's switches are copied as a thread's are). It is not a fork of Personal: a Topic starts with none of
Personal's transcript. Create is idempotent by operation id and serialized in the isolate: a retry or a concurrent
repeat returns the same Topic, and only one Pi session is registered. The name is checked before the session is made,
so a clash (409 `Conflict`) leaves nothing behind. A crash between making the session and registering it would leave
one unregistered, unreachable Pi session; the retry registers a new one.

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

`GET/POST /api/topics` and `PATCH /api/topics/:id` (`topics/routes.ts`) are strict-CSRF browser writes, and run as owner
requests through `topics`, `createTopic` and `updateTopic` on the Agent. The workspace feed's snapshot carries
`topics`, each change is a `{ type: 'topic' }` item, and every `ConversationView` carries its `topic` and, for a
Topic's Conversation, `conversation: true`. An older client ignores all of these.

## Per-Topic memory

Every Topic's Conversation keeps the long-lived summary memory Main has had (OptChat, `memory/`). The additive
migration `20261026000100_chat_memory` creates `app_chat_memory_log`, `app_chat_memory_nodes` and
`app_chat_memory_state`, keyed by `chat_id`, and copies Main's agent-wide `app_memory_*` rows into chat `1` with every
idx, entry id and node unchanged. The old tables stay, no longer read.

`ChatMemory(chat)` is the old `MainMemory` with every query keyed by chat id and the chat's Pi session resolved on each
use, so a rebind moves no row. `ChatMemories` (the `Memories` service) holds them: `of(chat)`, `activate(chat)` (the
`goblin.memory` and `goblin.recall` extensions, once) and `truncate(chat, size)`, which forgets the messages from
`size` on and every summary covering one, and pulls the view back to `size` at most; Move to thread uses it.
Composition activates every Conversation without memory (a fresh agent's Personal, or a Topic whose activation a crash
cut short), and creating a Topic activates its Conversation, again on a retry with the same operation id.

The builder (`pi/memory.ts`) resolves its chat with `chatOf(conversationId)` and works only for a Conversation; a
thread or subagent remembers nothing of its own. `zoom` reads the memory of the Conversation above its caller
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
