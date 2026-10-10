# ADR 0037: Conversation flows and failure reporting

Accepted 2026-10-09 with the owner (the debuggability plan: an Effect-native runtime, one typed API and visible
conversation flows). Builds on ADR 0024 (observing conversations: the run ledger, inspection and no content in
telemetry), ADR 0030 (logical chats), ADRs 0032 to 0035 (Topics, Personas, Move to thread, retrieval) and the typed
owner API that the agent serves (ADR 0038).

The owner wants to hit an error or strange behaviour in the app and see what happened, and above all how people and
agents move through conversations: replies, "+", start thread, move, Personas, Delegates. Until now the run ledger
recorded Pi turns only, an unexpected failure was logged without a location, and the app showed no reference to
look one up by.

## Flow events

A flow step is one content-free `FlowEvent` (`packages/contracts/src/telemetry.ts`): which flow (`send`, `reply`,
`start`, `move`, `persona_ask`, `subagent_spawn`, `topic_create`, `routine_fire`, `telegram_delivery`,
`client_error` and the rest of `FlowName`), how it came in (`via`), who acted (`actor`), the logical chat ids, the Topic,
the operation id and the operation that caused it (`parentOperation`), counts, the Persona order, and how it ended:
`ok`, `replayed` (the same operation id found an earlier result), `refused` or `error` with a safe error code. Never
text, arguments or results.

- **Recording.** Programs record a step with `FlowEvents.record`, or wrap a whole operation in `withFlow`, which
  records how it ended (`observability/flows.ts`). Neither fails the flow it describes: a sink that fails is reported
  instead. Each area records at its own emission points.
- **In the run ledger.** A step becomes one run event of kind `flow` (`flowRunEvent` in `telemetry/events.ts`): the
  operation id has its own column, so the step shows in its operation's timeline, and the rest are allowlisted
  `goblin.flow*`, `goblin.actor`, `goblin.chat*`, `goblin.topic`, `goblin.operation.parent`, `goblin.count`,
  `goblin.persona.order` and `goblin.subagent.synthesize` attributes (`telemetry/safety.ts`). A `refused` step is stored
  `blocked`, an `error` step `error`. Ledger reads skip a row of a kind they do not know, so a rollback to a build
  without flows still reads the rest.
- **In problems.** A failed step needs attention; a refused one (a move of a busy chat) is an answer the owner already
  saw, so problems leave it out unless `all` is asked for, as they do expected authority waits.

## Readers

- **`inspect_flows`** on `/mcp`, and so `goblin flows`: an agent's flow steps since a time, newest first, by chat or
  flow.
- **Details** (`inspect_details`, `goblin details`, and the owner's own `GET /api/conversations/:id/details`): what
  happened behind one message, by its operation id or by the chat entry that is its model answer or tool result (the
  ledger names that entry, `goblin.entry`). It is the operation's timeline: with its turn and Pi's settlement when it
  ran one, or only its steps when it did not (a passive write, a move). `related` lists the operation's parent and the
  operations it caused: by the flow graph (`goblin.operation.parent`) and, for rows older than flow events, by the ids
  derived from it (a Persona's answer `persona:<operation>:<persona>`, a thread's first send `<operation>:first`). Once
  every operation has a durable receipt with its parent, the receipts are the first source.
- **Turns** count their `error` events (a failed subagent relay, an app job), and `diagnose` shows each event's
  `goblin.task.kind`.
- A Persona's answer is a `persona` turn source; the dead `thread-started:` prefix is gone.

## Across agents: Analytics Engine

Each agent's flows, with their ids, stay in its own ledger. For the operator, every agent's flow steps also go to a
Workers Analytics Engine dataset, `goblin-<stage>-flows`, bound as the optional `FLOWS` (`observability/ae.ts`):

- **One point per operation**, its first step; a step without an operation id is written as it comes.
- **Layout:** `indexes: [agentHash]`; `blobs: [flow, via, actor, origin, status, errorType, stage, build,
  personaOrder]`; `doubles: [1, count, ms, depth]`, where `depth` is 1 for a step another operation caused. Origin
  stays empty until steps carry it, and an agent's points leave build empty.
- **Browser crashes.** The Worker writes a crash report's `client_error` point (`crashPoint`, `http/api/account.ts`)
  with the report's own build (the web build's `VITE_GOBLIN_BUILD`, `dev` when it names none). The point is indexed
  by the agent's hash only when the report came with a session; a signed-out crash has no agent index, so
  `goblin stats` cannot tell signed-out crashes apart by agent.
- **No chat or operation ids**, and no content.
- **Hashed agent id.** `agentHash` is HMAC-SHA-256 of the user id under a key derived with HKDF-SHA-256 from
  `CREDENTIAL_KEY` and the label `goblin/flows/agent-v1`, as 16 hex characters. It is stable for one key and label, the
  user id cannot be read back from it, and a new label rotates every agent's hash. Privacy hardening beyond this can
  come later; the owner accepted that.
- **Reading it.** `goblin stats` sums steps, distinct agents and mean duration per flow and outcome, weighted by the
  sample interval, through the Analytics Engine SQL API with the operator's own `CLOUDFLARE_API_TOKEN` (Account
  Analytics read). The token goes to Cloudflare only and is never printed.

## Failure reporting

- **One content-free logger** (`observability/logger.ts`) writes every runtime line, from `Effect.log*`, from named
  events (`logEvent`) and from synchronous sinks (`writeLine`). A line keeps allowlisted keys of the right shape and
  run attributes through their own allowlist, never a message or cause. The run log (one `run` line per ended run
  event) and the telemetry sinks' own failures write through it.
- **A failure line** (`event: failure`) names where it was reported (`goblin.where`), the error's type and its stack
  locations, never its message (`observability/report.ts`). Typed answers (a 404, a 409, a 402) are not failures.
- **References.** A failure the owner sees quotes a reference: the edge's cf-ray when a response came back, otherwise
  the browser's request id. `goblin lookup <ref|request|op>` finds the Worker's log lines that mention it, then shows
  the details of the operation they name. A browser crash is reported as a content-free client error, which is also a
  `client_error` flow step.

## Consequences

- A strange reply can be traced from the app's reference, to the Worker's lines, to the operation's details and its
  related operations, without reading any content beyond what inspection already shows the owner's own clients.
- The ledger gains a row per flow step; its 30-day retention and the per-row attribute bound apply.
- Analytics Engine keeps aggregates across users: sampled, ids hashed, no chat or operation ids. Rotating the label
  breaks continuity of the series on purpose.
- Rolling back to a build from before the tolerant ledger decode would fail on `flow` rows; roll forward instead.
