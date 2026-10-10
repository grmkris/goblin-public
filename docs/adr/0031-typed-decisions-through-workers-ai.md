# ADR 0031: Typed decisions through Workers AI

Accepted 2026-10-09 with the owner. Builds on ADRs 0002 (stages and provider), 0024 (no content in telemetry), 0026
(daily budget in Credits), 0035 (cross-Topic retrieval) and 0038 (typed owner API). The evidence is the v4 decision
benchmark in [`bench/reports/decisions-decisions-20261009-v4.md`](../../bench/reports/decisions-decisions-20261009-v4.md).

goblin evaluates bounded candidates with Cloudflare Clef through the Workers AI `AI` binding. This is a scoped exception
to [ADR 0002](0002-stages-and-provider.md): conversational and housekeeping models still use Railway LiteLLM in deployed
stages. Clef is not a chat model choice and never generates a reply, a title or an instruction. Only the dev stage binds
`AI` (`apps/web/alchemy.run.ts`). A stage without it (prod, the local stack, the native test stacks) has an unavailable
Clef, and there the decisions judge nothing at all, rules included: the owner chats' hooks make no call and no proposal.

## The critic

The `Decisions` service (`decisions/`, built by `layers/decisions.ts`) applies deterministic state-only rules first,
asks Clef only for undecided ordinary cases, then rechecks the current registered chat, resident authority and relevant
state before keeping a proposal. `none` and `uncertain` remain valid ways to decline a suggestion. An unavailable
binding, a five-second timeout, a malformed answer, an exhausted budget or stale state produces no proposal and leaves
the conversation working as before. A model call never holds a SQLite transaction, Pi commit or lifecycle gate open. A
judgment runs at most once at a time per proposal (`SingleFlight`), and one already kept is never judged again.

Every call checks the owner's budget before dispatch and records returned usage as model `clef` into estimated Credits
([ADR 0026](0026-daily-budget-in-credits.md)). Clef uses an explicit input-only app-budget estimate of 5,000 input
tokens per Credit, overridable through `GOBLIN_MODEL_CREDIT_RATES` (`output: null`). Its published $0.24/M input-token
price does not establish a USD-to-Token-Plan-Credit exchange rate. Unknown usage is charged at the bounded full
65,536-token context reservation rather than treated as free. Each call is a `model.aux` event of purpose `decision`
and model `cloudflare/clef`, with content-free timings, outcome and token counters
([ADR 0024](0024-observing-conversations.md)); proposing, confirming and dismissing are the content-free flows
`decision_propose`, `decision_confirm` and `decision_dismiss`. State, questions, answers and proposal payloads never
enter telemetry.

## The judgments

The first judgments propose attention highlights for Delegate reports, a draft thread for separate work, and earlier
work from the owner's other chats (cross-Topic context relevance). Reports remain visible and unread/completion state
stays a runtime fact. A report is judged after its write and outside any Pi commit, keyed by the relay's stable
identity, so resumed work cannot create another proposal for it; questions, approvals and failures are never ranked.
An owner exchange is judged after the final answer (`goblin.decisions`' `onYield`), fenced on the chat's session, epoch
and a digest of the exchange, so a newer one makes the proposal stale. Helpers and routine runs never install the
extension.

Context candidates come only from the transcript index of ADR 0035 under its default Topic policy (active Topics that
take part in search, never the asking chat or a Persona fork): the top three sources of a search for the owner's newest
message that automatic retrieval did not already give it, each judged relevant or not at the frozen v4 threshold, with
"none relevant" a valid outcome. This ADR grants no new retrieval authority.

## The owner's label

The signed-in owner confirms or dismisses each proposal with `POST /api/decisions/:id` (the `decisions` group of the
owner API, [ADR 0038](0038-typed-owner-api-served-by-the-agent.md)), which derives the agent from the session user; no
endpoint accepts an agent selector. Application-owned `app_decision_proposals` and `app_decision_labels` (migration
`20261026000600_decisions`) keep the outcome and its provider and probability. The first label wins: the same label
again answers the same proposal, the other one is a conflict, and a proposal whose chat moved on cannot be confirmed
and goes stale. Labels do not themselves enable automatic behavior.

Confirm may highlight an existing report, open an empty thread draft, or use earlier work: for a day the chosen
excerpts join the chat's requests as goblin's quoted-history note (a `beforeRequest` context block, never a transcript
entry), and each later owner message they serve records an `auto` source use, so that answer's source strip names
them. It never moves history. The v4 independent held-out report does not establish readiness for any automatic
judgment.

Decisions never grant authority, hide questions or approvals, declare external work complete, change a send's
destination, merge transcripts, or change any grant. All candidate prose is untrusted data.

## Delivery

Proposals reach the browser through the owner-only workspace feed: the snapshot carries the newest open and confirmed
ones and each change is a `proposal` change. The web keeps them as the workspace's `proposals` slice and renders each
open one in its chat's "Only visible to you" slot; they are not appended to Pi transcripts or sent to Telegram.
Confirming a thread suggestion opens an empty thread draft in the browser that confirmed it. Local unit and native
workerd tests use a fake Clef and never dispatch paid Workers AI; they are separate from the dev deployment and owner
acceptance.
