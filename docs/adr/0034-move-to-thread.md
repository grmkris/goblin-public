# ADR 0034: Start thread and Move to thread

Accepted 2026-10-09 with the owner (Topics, round 4 of the spec). Builds on ADRs 0017, 0030 and 0032; the shell that
shows thread heads is ADR 0036.

In a Slack-style channel a Thread hangs under one message, its head. The owner can start a Thread before sending
(the composer's toggle), or move a turn already answered into a Thread. Both keep the head message in the channel and
the conversation that follows it in the Thread.

## Start thread

`POST /api/conversations/:id/threads` takes the ordinary `SendMessage` body. `startThread` (`chats/thread-heads.ts`)
does three idempotent steps:

1. `Conversations.startThread` makes the Thread once per operation id. The additive migration
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

### One thread operation (2026-10-09)

Reply in thread, "+" and Start thread became one idempotent operation. `POST /api/conversations/:id/threads` takes
`ThreadStart` (`{ operationId, anchor, message, personaOrder? }`): `anchor` is `{ entry }` (Reply: a fork at that
entry, as a branch), `empty` (an empty Thread under the Conversation the chat sits under, announced once titled) or
`latest` (Start thread, as above, with its head). The message then goes into the Thread as `<operationId>:first`, its
receipt naming the operation as its parent, with the message's Persona order. The chat records the operation's receipt
(`start`, `reply` or `empty`, settled with the Thread it made) and its flow. `POST /api/conversations` with an
`operationId` takes the same path, so a double create makes one Thread (C4). The web keeps a Reply or "+" draft in the
browser until its first send, which is this one call.

## Move to thread

`POST /api/conversations/:id/move` takes `MoveToThread` (`entry`, `operationId`) and returns a `MoveReceipt`. The same
operation id returns the same receipt; the same operation id from another chat, or for another message, is 409
`Conflict`, and so is a second move of a chat while one is in flight.

**Shipped: the settled-turn move (the owner-approved fallback MF).** Only a Topic's Conversation moves, only its newest
turn, and only once that turn has finished. The `Moves` service (`chats/mover.ts`) checks under the
chat's admission lock that the message is the owner's `pi.user` entry in the chat's own session, that the chat has no
run and no queued input (`streaming`), that the message started the newest turn still shown (`not_latest`: a steer,
placed after a tool round, never counts as a start, and entries a later entry omits are skipped), that it has not
moved already (`moved`), and that no MCP call of the session waits on the owner's approval (`awaiting_approval`: the
approval's continuation resumes the session it came from). A refusal is stored as a `refused` row, so its operation
answers the same. Then, still under the lock:

1. **Fork** (`pi/moves.ts`, one Pi commit on the chat's session): the Thread is a fork at the turn's last own entry,
   made a thread (the thread extension, `recall` where the chat has memory, no instructions, the chat's tool filter),
   with the helpers the turn started copied onto its roster. A session-scoped witness document keyed by the operation
   holds the fork, read first, so a repeated commit finds it instead of forking again. The primary chat's memory
   builder is stopped first.
2. **Rows** (one SQLite transaction, `chats/moves.ts`): the Thread's `app_conversations` row (its own session, in the
   chat's Topic, `origin_op` = the move's operation, `fork_entry` = the chat's entry before the moved message so its
   replies count from the message, `recall_through` = the chat's memory up to that entry), and under it the threads
   branched from the turn and the helpers it started; its MCP App placements; its skill activations. The chat's
   switches are copied to it.
3. **Head**: an `app.thread_head` (`moved: true`, request id `thread-head:<op>`) passive-written into the chat. Its
   model text is only `[moved to thread "<title>"]` (the title is the message's first line) and its Pi `edits` omit
   the turn's own `pi.user`, `pi.assistant` and `pi.tool-result` entries from the chat's model context. Passive
   notes that landed in the turn (a share-back, a routine report) stay in the chat.
4. **Memory and index**: the chat's memory (ADR 0032) forgets every message from the moved one on, with every summary
   over them (`forgetFrom` at the memory's size before the message), and its collector skips entries a
   later entry omits, so the turn is never remembered again. The memory builder does not start while the chat has a
   move in flight. The cross-Topic index (ADR 0035) gives the session's entries from the moved message on to the
   Thread (`reassignExcerpts`).

Outside the lock (stopping a relay waits for it, and a relay's report waits for that lock), the live relays carrying
messages to the turn's helpers are chosen once (stored on the row), made again in the Thread with their original
delivery request ids (so no message is delivered twice) and stopped in the chat; those helpers' `spawner_session`
becomes the Thread. The row is then `settled`. A restart finishes a `requested` or `forked` row when the services
start again, or when the same operation is repeated; one run at a time per operation (`SingleFlight`).

The moved Thread is an ordinary thread: Stop and Close reach only it, and the chat never rebinds. The moved message's
Telegram or inbound operation already has its answer, which stays where it was delivered.

**Built and measured, not shipped: the running-turn identity swap (§3a of the design).** Pi cannot move a running
turn, so the swap made the running session S the Thread and a fork F of S, cut just before the moved message, the
chat (an epoch-fenced `rebind`), with the queue withdrawn from S and carried into F, the chat's notes re-placed, the
pre-cut helpers' relays handed to F, and S reconfigured as a thread once idle. All nine native tests of the design
passed locally (no second model attempt, every queued owner, inbound, share-back and concurrent input answered once,
the chat's stream ending for a fresh snapshot, restarts after the cut, the swap and mid-settle, Stop and Close at the
boundaries, helpers reporting on the right side, zoom bounded at the cut, an approval resuming S). It hit a kill
criterion: every swap makes the chat's session a fork of the previous one, and Pi reads a forked conversation with
one query per ancestor (`readEntries`, `readLatestHeadMarker`). After 20 chained moves the chat's `entries(50)` plus
`context()` cost 412 ms per 200 rounds against 139 ms for a control chat with the same visible transcript that was
never forked (3.0×; the criterion is 2×). No goblin-side fix exists: Pi has no API to flatten a fork, and copying
entries would change their identities. The implementation and its tests are kept on the local branch
`archive/move-swap` (`844b73a`), never merged.

**Upstream ask (Pi Durable).** A way to flatten or copy a fork chain, or to cap its ancestor depth, would make the
swap's cost constant and unblock moving a running turn; so would a supported way to move a running turn between
conversations. Until then a running turn is refused with `streaming` and the web says why.

A move also records a `move` receipt in the chat (2026-10-09): settled with its Thread, or refused with the mover's
reason, and its `move` flow. `app_chat_moves` stays the authority; the receipt indexes it.

## Verification

Local workerd, owner suite (so the permuted-primary profile runs it too). Move (`test/integration/move-case.ts`): the
chat's next request is the turns before the move, the head's note and the new message, never the moved turn; the
Thread's next request goes on from the turn; the memory never logs the turn; the same operation repeated, also at
once, makes one Thread; a running, older, moved, non-user or non-Conversation target is refused with its reason; a
restart after the fork or after the head finishes the move once; a Stop of the chat while the move waits after its
fork leaves the move to finish, and Close of the moved Thread stops only its run; a helper the turn started reports
to the Thread and an older one to the chat; zoom from the Thread stops at the moved message; a turn waiting on an
approval stays; a non-Personal Topic moves the same way; and after 20 chained moves the chat's reads cost 135 ms per
200 rounds against 151 ms for the unmoved control (0.9×). Unit (`test/moves.test.ts`): the row states, the Thread's
rows and what moves under it, and the memory truncation.

Start thread, local workerd (`test/integration/thread-heads-case.ts`): the
head and its model text in the channel, the answer only in the Thread, the fork's inherited history, sequential and
concurrent retries giving one Thread and one head, a 409 for another chat, a fork before a held running turn, an empty
Thread in a new Topic, and a closed Thread refusing. Unit: the head's model text and its memory line. No deployed-stage
claim is made for either feature.
