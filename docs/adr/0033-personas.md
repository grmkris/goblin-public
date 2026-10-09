# ADR 0033: Personas, organize receipts and Delegate results

Accepted 2026-10-09 with the owner (Topics spec, section 5: Personas and Delegates). Builds on ADRs 0010, 0018, 0027
and 0032.

A **Persona** is a named, versioned agent definition the owner tags in the composer with `@name`. Each tagged Persona
answers once, attributed, in the same chat. Goblin does not answer that message. The same round makes two neighbours
honest: Goblin can **organize** the workspace on a direct request, every change leaving a receipt the owner can undo,
and a finished **Delegate** (subagent) posts its attributed result without Goblin answering it again.

## Definition and revisions

`PersonaRegistry` (`personas/registry.ts`, the `Personas` service) keeps the current definition in `app_personas` and
every revision in `app_persona_revisions` (migration `20261026000200_personas`; the frozen shapes are
`packages/contracts/src/personas.ts`). A Persona has a global name (a letter, then up to 31 letters, digits, spaces,
`_` or `-`; unique among active Personas, ignoring case), an avatar (a glyph on a hue), a one-line role, instructions
(8,000 characters), an optional model and **exclusions**.

- Create and update each write a new revision and bump `revision`. An update names the revision it edits
  (`expectedRevision`), compare-and-set in one SQLite step, so two edits never silently overwrite each other (409).
  Nothing changed writes nothing. Archive and restore are revisions too; an archived Persona keeps its history, no
  longer answers and frees its name. Create is idempotent by operation id.
- `model` must be one the deployment offers (`modelOptions(env.MODELS, env.MODEL_ID)`); `null` clears the preference. A
  model dropped from the list later is ignored when the ask freezes the Persona, so removing a model strands nobody.
- Exclusions are `HelperExclusions`, the same vocabulary as a helper's, and can only narrow. They are stored as given,
  de-duplicated, and applied on top of the chat's own switches; a Persona never gains a capability.

`GET/POST /api/personas` and `GET/PATCH /api/personas/:id` (`personas/routes.ts`) are strict-CSRF browser writes. The
workspace feed carries `personas`, `invocations` and `receipts` in its snapshot and `persona`, `invocation` and
`receipt` changes.

## The ask: no Goblin run

`composerOptions` offers active Personas as `persona` selections (label the name, description the role) in
Conversations and Threads, never in a subagent. In `submitOwner`, Persona selections are taken out before
`resolveSelections` (which refuses them on purpose). With any present, and under the chat's admission lock
(`personas/ask.ts`):

1. `admit(chat, op)`; one `app_persona_invocations` row per Persona, frozen at the revision current now;
2. an `app.persona_ask` entry (`PersonaAskData`) is written passively with request id `op`; its model content is
   `[to @A, @B] ` plus the owner's content. **No Goblin run starts**;
3. one `chat.commit` creates one background `goblin.persona-turn` task per Persona, guarded by an `app.persona-asks`
   document keyed by `op` (the pattern of `pi/routine-run.ts`), so a replayed send makes none twice.

`SendMessage.personaOrder` is `parallel` (default) or `sequence` ("then"): in a sequence each task waits on the one
before it.

## The turn: mechanism (a), fork and write back

`pi/persona-turn.ts` runs the phases `wait`, `place`, `fork`, `register`, `ask`, `write`:

- **place** waits (a bounded poll, never a lock) until the ask write is in the transcript; if the chat is busy it
  lands at the run's next boundary. **fork** cuts the chat at the ask entry, or, in a sequence, at the predecessor's
  answer, so the second Persona sees the first's answer and parallel Personas never see each other.
- The fork is `tx.forkConversation` owned by the task, with the Persona's model if set, **without** main's memory
  extension and **without** the tools a Persona never has (the subagent tools, `share_back`, `ask_user`, the organize
  tools, routine and Home editing). A `beforeRequest` hook adds the frozen revision text to the `<goblin-context>`
  tail, only in a conversation that holds the `app.persona-turn` marker document. The system prompt and every message
  before the tail are the chat's own, so the provider's prefix cache is shared with the chat's last request.
- **register** lists the fork in `app_conversations` with role `persona`, kind `thread`, in the parent's Topic. It is
  hidden: not listed, refused by `requireOpen` (`persona_turn`), skipped by the feed and Topic archiving. The chat's
  switches are copied, then the Persona's exclusions and a `subagents` exclusion are added: **Personas never delegate
  or loop**.
- **ask** prompts the fork with `Answer the owner's message above as @name.` (request id `persona:<op>:<id>`). The
  budget and resident authority are checked before the model is asked. **write** passive-writes the answer into the
  chat as `app.persona` (`PersonaAnswerData`: Persona, name, **revision**, avatar, operation, text; the model sees it as
  `[from persona <name>]`) with the same request id, then marks the invocation `answered` with the entry id.
- Stop (`stopOwner`) aborts the chat's persona turns, using `inspect()` as `dropRelaysTo` does, and marks unsettled
  invocations `stopped`; the abort handler does the same for a task cut any other way. A settled invocation never
  moves again. Editing a Persona while its answer is held changes nothing for that answer: the task input holds the
  revision's text.

Per-turn swapping of the chat's own session was rejected: one live run per conversation forbids parallel answers and
races follow-ups.

## Organize tools and receipts

`pi/organize.ts` adds typed tools (ADR 0027) on main and threads: `topic_create`, `topic_rename`, `topic_archive`,
`persona_create` and `persona_update`. Their descriptions and prompt section say **only on the owner's direct
request**. Targets are named, not numbered (the active Topic or Persona with that name). Each change writes an
`app_organize_receipts` row (migration `20261026000150_organize_receipts`): kind, target, one-line summary, actor
(`agent` here, `owner` for the same change from the UI), the chat, the target **before and after**, and
`after_revision`. A tool call that runs twice finds its receipt (the call id keys it). Archiving from inside the
Topic's own run does not stop that run from within itself.

`GET /api/organize` lists receipts, newest first; `POST /api/organize/:id/undo` puts the target back (creation undone
archives; archive undone restores; rename and update restore the old values as a new revision). It applies only while
the target's revision still equals `after_revision`; otherwise it is refused as `touched` (409), and a receipt can be
undone once (`undone`). `undoable` in the list is that same test, so the UI never offers what would be refused. The
Undo is itself a receipt, owned by the owner.

## Delegate results (spec section 5)

A finished subagent's report no longer starts a Goblin run. `pi/subagent-relay.ts` writes it into its spawner's chat as
a passive `app.delegate_result` (`DelegateResultData`: the Delegate's chat, name, `done` or `failed`, text), whose
model content is still the labelled `[from subagent <name>]` message, so Goblin sees it at its next turn but answers
nothing. `subagent_spawn` takes `synthesize` (default false): with it the report stays an input and Goblin answers
once, as before. `subagent_send` inherits the flag recorded for the Delegate; the owner's own messages to a Delegate
follow it too. A job cut short still reports nothing. Telegram tracking of main's answer applies only when Goblin
answers.

## Consequences

- Persona turns are background tasks of the chat they were asked in; the chat's own run is neither held nor queued
  behind them. A Persona fork costs one model call, on the Persona's model if set, within the same daily budget.
- A chain of subagents with `synthesize` off gets no synthesis from the lead: its report goes up as soon as the lead's
  own turn ends. The subagent prompt tells Goblin to set `synthesize` when it will combine results.
- Receipts and invocations are in the workspace feed; none of it carries message content in telemetry (ADR 0024).
