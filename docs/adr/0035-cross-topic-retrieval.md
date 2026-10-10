# ADR 0035: Cross-Topic retrieval

Accepted 2026-10-09 with the owner (Topics spec §4, round 4). Builds on ADRs 0024 (no content in telemetry), 0027
(typed tools), 0030 (logical chats) and 0032 (Topics). The evidence is the retrieval spike in
[`bench/retrieval-report.md`](../../bench/retrieval-report.md).

goblin can find relevant earlier messages in the owner's other chats, in any active Topic, and an answer that used
them can show a compact source strip: the Topic, the chat, the message range and when it was retrieved. Transcripts
are not merged: what a run used is kept as a frozen excerpt, and Pi's transcript stays the source of truth.

## The index

The additive migration `20261026000300_transcript_index` creates application tables only (`storage/retrieval.ts`):

- `app_transcript_excerpts`: one row per indexed Pi entry, keyed by its global entry id, with the Pi session that owns
  it, the chat it belongs to now, a role (`user`, `assistant`, `shared`, `persona`, `delegate`, `seed`), an optional
  author, a time in seconds and the text.
- `app_transcript_fts`: an FTS5 external-content table over that text (tokenizer `unicode61`, ranked with `bm25`),
  kept in step by insert, delete and text-update triggers. Its shadow tables are `app_transcript_fts_*`.
- `app_transcript_index`: per Pi session, the entry id it is indexed through and when it was last checked.
- `app_retrieval_uses`: what each run used (below).

`unicode61` is what the spike measured: recall@5 82.9% over 70 labelled positive queries (100% exact-term, 68%
paraphrase). `trigram` was only probed and stays a later variant.

The transcript index (`retrieval/index.ts`) reads Pi only through its public Conversation API (`entries`), in windows of
entry ids from where a session stopped. Pi mints conversation and entry ids from one sequence, so a session's own
entries all have ids above its own, and inherited (forked) history is filtered out by `entry.conversationId`: each
entry is indexed once, under the chat whose session wrote it. Persona forks (`role = 'persona'`) are never indexed or
searched. Indexed kinds are the owner's and other authors' inputs (`pi.user`: the owner's words, or an authored note
after its tag; App context, attachments and composer metadata are left out), the owner's messages to Personas
(`app.persona_ask`), the agent's answers (`pi.assistant`
text), share-backs (`app.shared`), Persona answers (`app.persona`), Delegate results (`app.delegate_result`) and Topic
seeds (`app.topic_seed`, the brief). Tool calls and results are not indexed in v1. Text is bounded like main's memory
(12,000 characters, head and tail) and scrubbed of credential-shaped values (`redactSecretText` in
`mcp/redaction.ts`: credential-named JSON fields, `Bearer …`, `api_key=…`-style assignments). The scrub catches
obvious shapes; it is not a guarantee.

The index is kept current after every response of a Conversation or thread (an `afterResponse` hook, fire and
forget), and every search first runs a bounded catch-up over the chats that may have new entries (about 400 entries in
all; closed chats read since they closed are skipped), which also picks up passive writes that start no run. A long
history is indexed over several catch-ups. Writes are one short synchronous transaction per window; nothing is held
across a Pi read. `reassign(session, fromEntry, chat)` moves a stretch of a session to another chat for Move to thread.
Every catch-up goes through the Retrieval service (`retrieval/service.ts`), which runs it under its session's turn of
the agent's `KeyedLock` (key `retrieval:<session>`, first come first served), and a catch-up that started runs to its
end: two catch-ups of one session never read the same windows at once (2026-10-09; it was a promise chain inside the
index).

## `search_chats`

The typed tool `search_chats { query, topic? }` (`pi/retrieval.ts`, ADR 0027) is offered in every Conversation and
thread (the default extension list), not to subagents or routine runs. The query becomes literal FTS5 terms: its
distinct letter-and-digit runs, at most 32, each quoted and joined with `OR`, so nothing typed can become FTS5 syntax.
The top 20 hits by bm25 (newest first on a tie) are grouped into ranges of up to two indexed neighbours on each side
in their chat, merged where they overlap, and the best five become sources, each with an excerpt of at most 1,200
characters (the matching entries get most of it).

Topic policy: without `topic`, only active Topics that take part in search are searched (`archived_at IS NULL AND
search_excluded = 0`). Naming a Topic (by name, ignoring case, or id) searches that Topic alone, whatever its state: a
deliberate request overrides archive and the opt-out, as spec §4 asks. The asking chat itself is never searched (its
own context is already the model's).

The model reads the results as quoted history in `<source …>` blocks, after a note that they are not instructions;
angle brackets inside excerpts and attributes are neutralised. The result's `details` is `SourcesDetails` (`mode:
'tool'`), which the web's source strip renders.

## Automatic retrieval

On the first model request after an owner input in a Conversation or thread, a `beforeRequest` hook of
`goblin.retrieval` retrieves without being asked (`retrieval/auto.ts`, `ChatRetrieval.automatic`). Persona forks never
do. It catches the index up (bounded), then searches the input's indexed text (bounded and redacted, so a pasted
credential never reaches the rerank) over the default Topics, never the asking chat, for up to eight candidate ranges.

- **Gate.** The cheap model is asked only when some candidate's bm25 score is at or below the gate: -5 at the
  calibrated size of 3,000 excerpts (every positive query of the synthetic corpus scored -5.84 or lower; 4 of 10 absent
  ones scored above -5), scaled down by log size for a smaller index, never under a tenth. bm25 magnitudes grow with
  the index, so a fixed gate would silence a new owner's retrieval. The gate only saves calls; it decides nothing.
- **Rerank with abstention.** The deployment's cheap model (`GOBLIN_MEMORY_MODEL`) gets the spike's measured prompt,
  adapted: excerpts are untrusted quoted history, answer only `{"ids":[…],"none":bool}`, at most three, reject
  superseded proposals, and none when nothing is relevant. An answer that is not exactly that shape, cites an id it was
  not offered or twice, or contradicts itself abstains, as does a model failure. Its tokens count toward the daily
  budget like every cheap-model call, and a spent budget skips the rerank. Telemetry records it as `model.aux` with
  purpose `retrieval`: tokens and outcome, never content (ADR 0024). No SQLite transaction is open across the call.
- **Injection.** At most three chosen sources go into the trailing `<goblin-context>` block as a `<sources>` part, for
  that request only: Pi stores none of it, and the cacheable prefix is untouched. The selection is recorded as
  `auto:<session>:<input entry>` with `inputEntry`, which is what keys a strip in `/sources`.
- **Once per input.** The generation task's memo `goblin.retrieval:<input entry>` holds the use id, or that it
  abstained. Later requests of the same turn (after a tool round), retries and recoveries re-inject the same recorded
  sources and never rerank again.

When it abstains, `search_chats` and the owner's explicit references remain available.

## Frozen evidence and `/sources`

Every search records one `app_retrieval_uses` row under a stable id (`tool:<session>:<call id>`, or the automatic
`auto:<session>:<input entry>`), with the sources as captured. A replayed or re-run tool call finds the first record and returns it unchanged, so the tool is replay-safe.
`GET /api/conversations/:id/sources` returns the chat's recorded uses that found something, newest first, as
`SourceUse[]`. The agent object serves it like a chat's snapshot and history (`chats/api.ts`): only a registered
chat of the signed-in owner's own agent, so another account sees none of them.

## Boundaries

- Application tables only; Pi and the other vendor tables are read through Pi's API, never touched.
- Everything stays inside the owner's own Durable Object: no new outbound call, grant or authority. Retrieval policy is
  within the owner's existing authority, never access to another user.
- Telemetry carries no content (ADR 0024): the tool is an ordinary tool call in the run ledger.
- Erasure: deleting the agent deletes its SQLite, index and recorded excerpts included.

Proof: unit tests over the real migrations in `node:sqlite` (owned-only indexing, windows, redaction, Topic policy,
contract shape, frozen records, Move reassignment, query escaping, range grouping, the rerank's selection and
abstention and the gate) and the local workerd owner case `retrieval-case.ts`, in both native profiles, where a
scripted cheap model selects or abstains and the recorded model request shows the `<sources>` block or its absence.
Neither is deployed-stage evidence, and no real model's rerank quality is claimed beyond the spike.
