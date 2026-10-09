# ADR 0034: Start thread and Move to thread

Accepted 2026-10-09 with the owner (Topics, round 4 of the spec). Builds on ADRs 0017, 0030 and 0032; the shell that
shows thread heads is ADR 0036.

In a Slack-style channel a Thread hangs under one message, its head. The owner can start a Thread before sending
(the composer's toggle). Both keep the head message in the channel and the conversation that follows it in the Thread.

## Start thread

`POST /api/conversations/:id/threads` takes the ordinary `SendMessage` body. `startThread` (`chats/thread-heads.ts`)
does three idempotent steps:

1. `ConversationRegistry.startThread` makes the Thread once per operation id. The additive migration
   `20261026000350_thread_heads` adds `app_conversations.origin_op` with a unique index; a repeat, also a concurrent
   one (serialized per operation in the isolate), finds the same row, and the same operation id from another chat is
   409 `Conflict`. The Thread is a Pi fork of the chat at its newest entry outside a running turn (`pi/turns.ts`: while
   a run is in progress, the newest entry before that run's first placed input, so a Thread never starts inside a
   turn), made a thread exactly as a branch is (ADR 0017). A chat with no entries gets an empty Thread. The Thread is in
   the chat's Topic. A subagent's chat starts none (`start_thread`), and a closed chat or an archived Topic refuses.
2. An `app.thread_head` entry (`ThreadHeadData`: the Thread, the first 400 characters of the message, the operation id)
   goes into the chat as a passive Pi write under the chat's admission lock (`Chats.passiveWrite`), request id
   `thread-head:<op>`, so a busy chat places it at its next boundary and a retry is the same entry. Its model text is a
   bounded `[the owner started a thread: "…"]` (quotes, brackets and line breaks removed, at most 200 characters), which
   the chat's memory keeps as a user line. It starts no run.
3. The message goes into the Thread through `submitOwner`, the ordinary owner path, with the same operation id: its
   attachments, App context and composer selections apply there, and Pi deduplicates a retry.

The route returns 201 `{ thread: ConversationView, receipt }`. A crash between the Pi fork and the row would leave one
unregistered, unreachable Pi conversation; the retry forks again.

## Verification

Local workerd (`test/integration/thread-heads-case.ts`, owner suite, so the permuted-primary profile runs it too): the
head and its model text in the channel, the answer only in the Thread, the fork's inherited history, sequential and
concurrent retries giving one Thread and one head, a 409 for another chat, a fork before a held running turn, an empty
Thread in a new Topic, and a closed Thread refusing. Unit: the head's model text and its memory line. No deployed-stage
claim is made here.
