# Memory benchmark workspace

## Real-history overnight campaign

The campaign coordinator freezes several real-corpus manifests behind one identity and durable API budget. The
approved private campaign is `.local/bench/experiments/real-history-overnight-v1/campaign.json`: Claude prefixes at
19k/36k/66k/129k/258k source tokens, and one genuine Hermes Telegram DM at 32k/66k/113k. Each checkpoint has five
curated probes for exact detail, recorded rationale, latest state, superseded beliefs (`negative-constraint`) and
absent owner approval. No unrelated sessions, padding or generated histories enter the live experiment.

DeepSeek Flash is the common reader. Core arms are native Pi compaction, native/search, Qwen-written OptChat, and
that same tree/search. The first checkpoint of each corpus also compares DeepSeek and Muse writers. Arm order is
deterministically counterbalanced per probe. `modelTransport` pins route-specific thinking: Qwen/DeepSeek disabled,
Muse provider default. Native replay compacts closed tool exchanges in at most 65536 serialized bytes, extending
the same persisted actor. Search pairs reuse the same checkpoint without model calls. Probe forks never append their
questions or answers to the persistent source history.

Native scheduling uses a 32768-token window, 8192-token reserve and 2048 recent tokens; the calibrated native
compactor has 6144 output tokens. This avoids scheduling another summary immediately for a short recall probe.
OptChat keeps its maintained 4096-byte view. The transport capacity is independently 131072 tokens. These settings
are part of the immutable campaign identity; reports retain the actual rendered contexts and all reader compactions.

| Phase                   | Upstream attempts | Input ceiling | Completion including reasoning |
| ----------------------- | ----------------: | ------------: | -----------------------------: |
| Preflight               |                60 |        150000 |                          25000 |
| Memory construction     |              1400 |       7800000 |                         280000 |
| Answers                 |               440 |       1650000 |                          95000 |
| Independent Muse review |               100 |        400000 |                         100000 |
| Total                   |              2000 |      10000000 |                         500000 |

All phases, failed attempts and one transient retry use the same append-only `attempts.jsonl`; there is one active
upstream request and at most six attempts per answer. Each stage also declares its own envelope. The earlier
three-phase proposal has been rebalanced inside the same total so judging is accounted for. Unknown usage retains
the full reservation and halts further admission immediately. Breaches also halt admission. Legacy manifests retain
their smaller ceilings.

```sh
bun run bench:campaign-plan --campaign .local/bench/experiments/real-history-overnight-v1/campaign.json
heavy bun run bench:campaign-run --live --campaign .local/bench/experiments/real-history-overnight-v1/campaign.json
bun run bench:campaign-report --run real-history-overnight-v1
heavy bun run bench:campaign-resume --live --campaign .local/bench/experiments/real-history-overnight-v1/campaign.json
```

Freeze the checked implementation locally before live inference, preserving private corpus/provider paths. Every
writer route must pass native real-source preflight with the common reader. Stages advance only after at least 90%
answer completion, known settled usage, no breaches, monotonic build receipts and successful machine review.
Failure receipts are terminal; resume never reruns a failed or unfinished answer, preflight or judge request.
Resume rechecks completed stage totals, operational gates and sealed reviews against their ordered receipts before
opening providers. Completed stages and builds reuse their durable receipts. `progress.jsonl` exposes stage progress without source
payloads, and `builds.jsonl` records cold/extended/reused work, newly processed source count, API attempt IDs and time.

Muse reviews shuffled, blinded original answers in batches per question. Audited original label ranges and cited
delivery receipts bound its evidence; it does not read the entire transcript for every answer. `blind/*.packet.json`
contains the full authorized prefix for independent human review, with separate sealed mapping and vote templates.
The coordinator never repairs malformed answers or judge output. Machine scores are diagnostic. Audit a balanced
sample across corpora, lengths, categories and arms, plus all disagreements; import independent human votes and
adjudicate disagreements with the existing review tools. Unaudited cases remain unresolved.

`campaign-report.json` separates build, reader, preflight and judging usage; reports per-corpus/length/category/model
quality, paired gains/losses/ties, API latency, coordinator time and retrieval attempts/bytes/denials. Context
summaries count serialized messages actually sent and reported prompt tokens, without exposing source text in the
summary. Full private contexts remain in API/native traces. Construction amortization
uses completed answers sharing that memory; warm reuse is not a zero cold-build cost. Dollar prices and TTFT remain
unknown. Product criteria require at least ten percentage points recall gain on both long histories, no category
loss above five points, no increase in unsupported claims or leakage, and latency/amortized cost below twice native.
Writers within five points of the best quality can compete on cost. Search gains require original cited delivery;
ties favor native. Two histories provide exploratory product evidence, not statistical generality or deployment
authorization. No campaign path promotes a production configuration.

Native Pi memory experiments in an isolated Alchemy/workerd stack. The starter compares the full GLM 5.3 / DeepSeek
V4 Pro 0813 writer-reader matrix against Pi's own compactor and Pi plus lexical archive search: 3 development
families × 2 cutoffs × 2 probes × 8 configurations = 96 answer episodes. Three distinct families remain held out.
Model IDs are exact catalog routes: `glm-5.3`, `deepseek-v4-pro-0813`, `deepseek-v4.1-flash`. Catalog discovery does not prove inference.

```sh
bun run bench:plan --manifest bench/experiments/starter.json
heavy bun run bench:run --manifest bench/experiments/native-smoke.json --run smoke-01
bun run bench:report --run smoke-01
bun run bench:resume --run smoke-01
```

Runs default to a keyless, deliberately lossy fake provider. This tests the complete harness, not model quality.
The runner starts and stops its credential relay and local workerd on ports 18873/18872. Execution is sequential
(global concurrency 1, below the manifest ceiling of 2), so there is at most one call per model. `heavy` keeps
expensive host jobs coordinated; port conflicts fail without destroying another stack.

For live runs, create a mode-600 `.local/bench/provider.json` containing only:

```json
{ "baseUrl": "http://127.0.0.1:8317/v1", "keyEnv": "CLIPROXY_API_KEY" }
```

The interactive shell supplies the key. `bun run bench:doctor` checks the catalog without inference; `run --live`
checks the selected IDs before spending. The relay never sends the real key to workerd. No deployed data is used.

Controlled runs use 8192 context tokens, 2048 reserve, 1024 recent and a 4096-byte OptChat view.
`production-compatibility` keeps actual model/compaction/view defaults. Every attempt reserves conservative input
bytes and maximum output tokens before sending; provider usage reconciles the reservation. Missing usage keeps the
full reservation charged. All writer calls, reader turns and the one transient retry count. Global ceilings are
200 answers, 1000 attempts, 1M input and 100k output/reasoning tokens. Search and zoom share 4 calls and 4096 UTF-8
returned bytes per episode. Tool results cannot read outside the fork's fixed source prefix.
Each answer also has at most eight upstream attempts, including retries; `allowance.maxRequestsPerAnswer` can
declare a smaller ceiling. This durable limit isolates looping readers without consuming the other answers' budget.
The answer instructions require every JSON field, exact delivered source IDs and empty claims on abstention. These
instructions contain no expected facts and apply equally to both policies.

Private evidence lives under `.local/bench/runs/<run>/`: `resolved.json`, append-only `attempts.jsonl`, per-episode
scores, complete provider payloads and responses, native trace snapshots, failures and `report.html`. Files are
mode 600. Resumption checks source/corpus identity and keeps prior spend, skips settled results, and never silently
retries failed episodes. A torn ledger fails closed. A crash may leave `coordinator.lock`; confirm the coordinator
has stopped before removing that directory. Start a new named trial to rerun failed episodes.

OptChat artifacts share a writer archive across readers and successive prefixes. Native standard/search controls
share the coupled reader's actual Pi summary. Artifact keys include source, corpus, mode, profile, pressure, writer,
summary prompt and explicit `buildTrial`. Changing a recall guide leaves compatible writer memory reusable. The
resolved manifest is immutable. Change one factor in a copied named experiment; keep the incumbent frozen.

```sh
bun run bench:compare --run candidate --against incumbent
bun run bench:promote --run candidate-holdout --against incumbent-holdout
```

Promotion selects one configuration per held-out manifest, requires every planned episode, at least 90% supported
accuracy, no category regression, and zero future leakage, unauthorized reads, invalid citations, unsupported claims,
malformed answers or forbidden endorsements. Fake runs cannot promote. Admission is recorded in
`.local/bench/holdout-consumption.jsonl`; resume the admitted run instead of hiding repeat exposure. Promotion writes
a local incumbent receipt; it does not change production prompts. Semantic forbidden-endorsement detection is a
bounded deterministic check, so inspect failure traces before trusting a promotion.

Prices must be nonnegative and carry a YYYY-MM-DD date. Unknown prices/usage remain unknown. Reports show recorded
run spend; warm reuse is not a cold build cost. Increment `buildTrial` for an independently charged cold construction.
Executable continuation, deployed load and autonomous tuning are later extensions.

## Real-session canary

Hermes histories use a read-only SQLite transaction export from one completed Telegram DM; export only the fields
selected by [hermes-export.py](scripts/hermes-export.py), redirect stdout into a mode-600 private file, and import
with `--kind hermes-sqlite-export --targets 32000,64000`. Original compacted records remain evidence. The importer
omits hidden/meta records, rewound messages and compression replay copies while retaining the full original tool
results, IDs, roles and timestamps. It rejects damaged pairs and unsupported display kinds. Source length is measured
after reconstruction and redaction; the 2026-10-06 selected DM has about 113k genuine source tokens, not the inflated
160k estimate obtained by counting compressed copies. It must not be padded to 128k with invented or unrelated turns.

The explicit `retrieval.format: "compact-v2"` retains at most two search matches, short paired-call metadata and exact
original byte ranges, and includes remaining calls/bytes in its charged serialized response. It permits an 8192-byte
shared allowance; individual reads remain capped at 2048 bytes and fit the remaining allowance. Existing manifests
retain their 4096-byte allowance and prior response format. A private regression reproduces the actual CSS search
failure and verifies that two searches leave room to read the original `880px` and safe-area padding declarations.

`bench:import` freezes a private Claude JSONL snapshot, deterministic redaction map, normalized visible events,
line/block provenance, omissions, source compaction boundaries and complete checkpoints after 16k/32k estimated
source tokens (UTF-8 bytes / 4). It rejects damaged JSON, sidechains, unknown visible blocks, duplicate IDs and
unmatched calls. Hidden thinking/signatures, image payloads and the duplicate source compact summary are omitted.
Tool names, IDs, redacted arguments, timestamps and observed failure flags survive replay; adjacent streamed
assistant blocks and parallel calls share a Pi message. Historical tools are never executed.

```sh
bun run bench:import --source /absolute/path/to/session.jsonl --corpus my-session
bun run bench:canary --corpus my-session --labels /absolute/path/to/reviewed-probes.json
bun run bench:plan --manifest .local/bench/corpora/my-session/manifest.json
heavy bun run bench:run --live --manifest .local/bench/corpora/my-session/manifest.json --run real-01
bun run bench:review --run real-01 --review /absolute/path/to/semantic-reviews.json
bun run bench:report --run real-01
```

The labels file is an array of six `Probe` records (see [schema](src/schema.ts)): at each imported cutoff, one
`latest-state`, `evidence` and `abstention` probe. Each has prefix-only required claim meanings, allowed evidence
IDs, prohibited claims and a review rubric. The canary freezes a labeled corpus and its SHA-256 in a private
manifest, selects same-model OptChat writer/readers plus native compaction and native compaction/search for each
model, and caps execution at 36 answers. Real corpora require `--live`; fixture transport cannot supply their results.
No questions, facts or answers are generated by the importer. Corpus labels never reach workerd or the writer.

Real explanatory answers remain **review pending** until an identified reviewer records semantic judgments using
[Review](src/review.ts). Reviews append to a separate identity-bound ledger and cannot override runtime failures,
malformed answers, missing delivered citations, unauthorized reads or future leakage. Reports distinguish pending
reviews from scored failures. Accuracy uses completed, reviewed answers, with completion/review counts alongside it;
without reviewed answers it is unknown. Reports separate provider-reported tokens from budget charges, which retain
full reservations for missing usage. The six-arm development canary does not qualify for promotion.

Every API attempt records its reserved/observed usage, retry index, total response latency, returned model and
response ID, any request ID, and reported reasoning/cache details. Completion usage includes reasoning rather than
charging it twice. Missing usage retains its full reservation; missing cache/reasoning counts remain unknown.
Streaming is buffered, so TTFT is unmeasured. `X-Session-ID` keeps calls associated with the named run and a separate
operation header identifies build/answer scope. This does not guarantee provider idempotency. Exact payloads,
responses, replay-to-source group maps, settled build contexts and retrieval order remain private.

Redaction matches available credential literals through Effect Config and common credential/email/path patterns;
inspect the private normalized prefix and omissions before labeling. Redaction changes data, so review failures
against the private source snapshot rather than silently repairing them. The checked-in optional real-source
regression reads the frozen local canary if present; CI skips it and never substitutes generated data.

Controlled pressure and API capacity are separate: Pi schedules at 8192 context tokens, while newly generated real
canaries declare a 131072-token transport capacity. The installed API adapter otherwise subtracts a 4096-token
safety margin from the artificial 8k window and can clip summaries to one output token. New canaries preserve
provider-default thinking: the available GLM route rejects `enable_thinking: false`. An explicit `disabled` setting
remains available for separately tested routes; reported usage determines whether reasoning occurred.
Transport settings enter artifact identity and comparison compatibility. A failed build is recorded durably and
blocks its dependent episodes instead of causing repeated build calls; a new trial preserves the failed evidence.

The first live real-session canary (`real-claude-canary-01`) verified both exact model routes with 40 successful
HTTP responses, 595322 reported input tokens and 6464 completion tokens. It produced zero recall answers: the
artificial provider window clipped 36 requests to one output token; GLM also consumed almost all of its early output
allowance as reasoning. These are harness/provider findings, not memory accuracy. Its private evidence remains
under `.local/bench/runs/real-claude-canary-01/`. The transport fix has a regression against that observed payload.

The corrected-capacity trial (`real-claude-canary-04`) completed nine DeepSeek episodes at the first cutoff, with
27 build failures or dependent blocked episodes. Its nine model-assisted semantic reviews pass three episodes:
OptChat owner-request recall and OptChat/search abstentions on an unknown deployment SHA. Formatting, citations and
unsupported design details account for the other completed-answer failures. GLM rejected thinking-disable requests;
the second cutoff did not complete within the allowance. This is partial diagnostic evidence, not a model ranking.
Across trials 01, 02 and 04, budget charges total 983363 input tokens against the 1M ceiling, including unknown-usage
reservations. No further full trial fits that remainder. Private reviews, the report and findings remain in the run
directory; frozen manifests and API traces are preserved. Future runs need a fresh trial with separately accounted
allowances and provider-default thinking. Optional regressions use these actual artifacts without inference.

## Paired OptChat/source-search pilot

`optchat-search` uses the same writer tree, starting context and `zoom` as `optchat`, with `archive_search` and
`archive_read` added. Both arms share construction across cutoffs; the default GLM/DeepSeek matrix stays unchanged.
Explicit manifests may also select the exact `qwen3.8-flash` and `grok-4.7` routes. The worker registers readers from
the manifest. `transport.readerMaxOutputTokens` optionally caps each reader completion independently of the writer;
old manifests retain their previous output default. Tool requests use `tool_choice: auto`.
`transport.nativeCompactionMaxOutputTokens` optionally sets the output allowance for native construction only;
it leaves OptChat writer and reader limits independent. Unset, native Pi retains its installed default
`floor(0.8 * reserveTokens)` (1638 at the 2048-token reserve). This field changes the experimental configuration:
use a fresh immutable trial, preserve default-limit failures, and report calibrated controls separately.
The actor persists the active probe ID before prompting. Every model request during that probe, including native
automatic compaction, consumes its reader allowance and appears in reader call/token/time totals. Native summary
requests replace the answer's system instructions, so those instructions alone cannot establish operation scope.
Build admission stays closed while a persisted probe is active; recovery must not charge that work to shared construction.
Preflight checks writer and reader output limits by operation scope, including when both use the same model route,
and verifies the manifest's explicit thinking configuration. Disabling thinking requires a fresh named experiment;
the recorded usage must still fit every reservation before bulk construction is admitted.

Search ranks lexical matches in original text and recorded paired-call metadata, returning at most four original
excerpts within 2048 serialized UTF-8 bytes. A filename can locate its recorded Read result. `archive_read` accepts
`id`, optional `offsetBytes` and optional `maxBytes` (default and maximum 2048 for the complete serialized response,
including metadata and escaping). Responses include source kind, exact byte range, original size, truncation and
continuation offset; tool results include their recorded call and error status. Missing/future IDs both return
`Source unavailable.` Zoom, search and read share the same four-call/4096-byte allowance. Denied calls count.

Reader source receipts come from native replay-entry metadata for raw starting messages actually sent to the
adapter, and original ranges returned by successful retrieval. Summary source markers and generated IDs never
establish that an original was read. Zoom receipts require an original leaf body; opening a summary is not original
source delivery. Host scoring verifies each receipt against the exact authorized source bytes. Private episode
artifacts retain delivered excerpts for semantic review. A passing review must consider what the reader actually
received; `searchSupported: true` additionally requires a cited search/read receipt. Older evidence remains readable.

The approved private manifest is `.local/bench/experiments/optchat-search-pilot-01.json`: unchanged six labeled
probes at cutoffs 22/32, two arms, Qwen Flash writer and Grok reader. It caps the new trial at 12 answers, 200 upstream
attempts, 1M charged input, 50k completion/reasoning and concurrency one. Controlled pressure is 8192/2048/1024 with
a 4096-byte view, transport capacity 131072, provider-default thinking and reader output 4096. Writer calls retain
2448 completion tokens. Existing run manifests, labels and ledgers are not changed.

An optional manifest `preflight` declares a real scenario prefix, original owner source ID, lexical query and smaller
request/input/output ceilings. The pilot uses the first three original events (including the 567-byte owner request),
so the actual summarizer adapter must call Qwen. A native Grok fork must search, receive that original and return
strict source-cited JSON. The preflight caps six attempts/50k charged input/10k completion **inside** the overall
allowance, records `preflight.json`, and aborts bulk inference on failure. Failed preflight/episodes are never rerun
implicitly. No alternate model or larger allowance is selected automatically.

```sh
bun run bench:plan --manifest .local/bench/experiments/optchat-search-pilot-01.json
bun run bench:doctor --manifest .local/bench/experiments/optchat-search-pilot-01.json
heavy bun run bench:run --live --manifest .local/bench/experiments/optchat-search-pilot-01.json --run optchat-search-pilot-01
bun run bench:review --run optchat-search-pilot-01 --review /absolute/private/path/reviews.json
bun run bench:report --run optchat-search-pilot-01
```

Reports produce HTML and `report.json`, with per-probe paired outcomes, retrieval operations, completion/review
coverage, gains/losses and search-supported gains. Accounting separates preflight, shared construction and each
answer arm, with reported/charged tokens, observed reasoning/cache coverage and latency. Dollar cost remains unknown
without dated prices. Pin the implementation and private corpus in an isolated local snapshot before live inference;
concurrent source edits must not change a running trial's identity.

Efficiency tables cover every planned answer, including runtime failures, unfinished attempts and unstarted answers.
They count unique upstream API attempts (settlement replaces its reservation), transient retries separately from
ordinary model turns, and allowed/denied retrieval calls by tool plus returned UTF-8 bytes. Reader totals include all
recorded answer work; preflight and shared memory construction remain separate. Missing retrieval logs, dated prices,
reasoning/cache details and timing stay unknown, with explicit measurement coverage. Input/output charges include
retained unknown-usage reservations; reported totals include only known provider usage. Cost per correct answer is
unknown when no answer passes. Estimated spend uses the manifest's dated input/output prices; it is not a bill.

`apiLatencyMs` sums measured response durations and excludes tool execution and coordinator overhead;
`completeApiLatencyMs` is unknown when any attempt lacks timing. New results record monotonic coordinator timing:
`answerMs` runs from submitting the probe to receiving its native result, including tools and all model turns;
`buildMs` measures checkpoint readiness (which may reuse cached memory); `episodeMs` includes both and evaluation.
Failed execution records total episode time even when stage timings are unavailable. Older live evidence has no
coordinator timing, so it cannot establish end-to-end delivery speed or TTFT. Reporting never issues model calls.

All 12 answers must complete and be reviewed before a quality conclusion. Search is promising only with at least
one strict paired gain, no losses, at least one gain supported by delivered search/read evidence, both candidate
abstentions passing, and zero candidate malformed answers, invalid citations, unsupported claims, future leakage or
unauthorized reads. A tie demonstrates no benefit. Some questions are answerable from recent raw context: inspect
receipt origins before attributing a gain to search. This tiny development sample is diagnostic and cannot establish
statistical/model superiority or authorize promotion.

The first paired pilot (`optchat-search-pilot-01-live`, implementation `a83ca3e`) completed a native Qwen summarizer
call and a Grok search/read/citation round. Functional preflight passed in four attempts, but Qwen reported 4198
completion tokens (4101 reasoning) against the requested 2448. A later writer call likewise reported 2951/2448.
The coordinator was stopped after seven attempts, before any scored answer. Six attempts settled successfully;
one in-flight attempt remains usage unknown with its original reservation retained. Charged totals are 30075 input
and 11725 completion; reported totals are 11846 input and 9277 completion. The incomplete attempt may have additional
unreported reasoning, so actual spend is unknown. This gives provider/budget evidence, with no recall accuracy or
paired gain conclusion. The private preflight, API ledger and stop receipt remain unchanged in the run directory.

The relay now fails closed on reported input/output above its reservation, keeps the upstream response and actual
usage, returns a local budget error, and denies every subsequent attempt, including after restart. Native preflight
also requires reported usage within reservations. This cannot retroactively cap a provider that ignores the requested
total completion allowance: validate a route's reasoning-inclusive limit before another experiment. The approved
provider-default Qwen configuration needs that validation; no replacement model, altered thinking setting, increased
limit or automatic retry was made. Regressions use both injected admission services and the actual Qwen receipt.

Fresh trials 02–04 preserved that pilot and stayed within a separately accounted combined allowance of 200 attempts,
1M input and 50k completion tokens. Grok's default writer also exceeded its reservation. Qwen with thinking explicitly
disabled completed six cutoff-22 answers in trial 03; all six model-assisted reviews failed JSON, citation or
abstention requirements, giving three comparable pairs and no grounded search improvement. One answer made 71 API
attempts after repeated denied retrievals, motivating the per-answer ceiling above. Trial 03 was manually stopped
before the second cutoff settled; one in-flight reservation remains charged. Trial 04's 90k allowance could not admit
the next conservative cold-build reservation and produced no answers. Combined charges are 142 attempts, 976634 input
and 26643 completion tokens; prices and actual usage for the in-flight attempt remain unknown. The clarified answer
instructions and request ceiling have regression coverage but have not had a further live run. Private native
answers, reviews, readable comparisons and failure evidence remain under `.local/bench/runs/`.

## Recall v2: four arms on the frozen real session

This iteration compares native Pi compaction, native plus source search, OptChat, and OptChat plus source search.
Every writer and reader uses `deepseek-v4-pro-0813` with provider-default thinking. It reuses the unchanged six
reviewed real probes at cutoffs 22/32: latest state, evidence and abstention at each cutoff. Native arms share their
Pi summary; OptChat arms share their writer tree and normal `zoom`. Only the search factor adds `archive_search`
and `archive_read`. The native arm answers without OptChat. Historical commands are never executed.

Prepare a fresh private manifest without inference:

```sh
bun run bench:recall --manifest .local/bench/corpora/purrable-claude-canary/manifest.json --name deepseek-recall-v2 --build-trial 9
bun run bench:validate --manifest .local/bench/experiments/deepseek-recall-v2.json
bun run bench:plan --manifest .local/bench/experiments/deepseek-recall-v2.json
```

The prepared iteration uses trial 9, above the preserved trials 0–8. Choose a new name and trial for another cold
experiment. Creating or reporting a manifest performs no model inference. Existing runs, labels and strict reviews
are preserved; the legacy `bench:review` path retains its original interpretation.

`bench:recall` accepts `--model <catalog-route>` and `--thinking provider-default|disabled`. Defaults remain
DeepSeek Pro with provider-default thinking. For the smaller DeepSeek route, use `--model deepseek-v4.1-flash`.
Disabling thinking changes every writer and reader consistently and requires a fresh named trial. The first
provider-default DeepSeek Pro preflight exhausted all 2448 writer completion tokens in reasoning, returned no text,
and aborted before any benchmark answers. Preserve that failure; do not resume it or silently alter its settings.

| Allowance                 | Attempts | Charged input | Completion including reasoning |
| ------------------------- | -------: | ------------: | -----------------------------: |
| Entire run                |      200 |     1,000,000 |                         50,000 |
| Preflight                 |        6 |        50,000 |                         10,000 |
| Memory construction       |       50 |       400,000 |                         15,000 |
| Readers                   |      144 |       550,000 |                         25,000 |
| Each cutoff: construction |       25 |       200,000 |                          7,500 |
| Each cutoff: readers      |       72 |       275,000 |                         12,500 |

The run caps 24 answers, six upstream attempts per answer (including the one possible transient retry), concurrency
one, and four retrieval calls/4096 returned bytes per answer. Pressure remains 8192/2048/1024 with a 4096-byte view;
API capacity is 131072 and each reader response reserves at most 4096 output tokens. Envelopes are ceilings, not a
promise of completion: conservative input-byte/output reservations must fit global, phase and cutoff budgets before
any request is sent. Denied admission adds no spend. Budgets restore from unique final attempt records after restart.
A provider exceeding its reservation halts subsequent admission, and unknown usage retains its reservation.

After approving live execution, pin the implementation in an isolated local snapshot with the private corpus and
mode-600 CLIProxy config; run both stages from that same snapshot. Source/corpus identity must remain unchanged:

```sh
heavy bun run bench:run --live --manifest .local/bench/experiments/deepseek-recall-v2.json --run deepseek-recall-v2-live --until-cutoff 22
bun run bench:report --run deepseek-recall-v2-live
heavy bun run bench:resume --live --run deepseek-recall-v2-live --until-cutoff 32
```

A staged run defaults to its first cutoff. Cutoff 22 stops after 12 planned answers. `stages.jsonl` seals cumulative
completion, unique charged usage, remaining phase/run allowance and pending answer IDs. Advancing to 32 requires
that identity-matching receipt, all earlier answers completed, known settled usage, no reservation/request/phase
breach and enough budget for the remaining declared envelope. Answer quality does not block this operational gate.
Failed stages and episodes remain evidence; use a fresh named trial rather than retrying them. Unfinished answer
attempts also fail admission. A completed resume avoids provider startup and preflight. There is no automatic
continuation into the second stage or automatic budget increase.

Export blind packets, then have an independent machine reviewer and a human fill separate copies of the template:

```sh
bun run bench:review-packet --run deepseek-recall-v2-live --packet stage-22 --until-cutoff 22
bun run bench:review-votes --run deepseek-recall-v2-live --packet stage-22 --review /absolute/private/path/machine-votes.json
bun run bench:review-votes --run deepseek-recall-v2-live --packet stage-22 --review /absolute/private/path/human-votes.json
bun run bench:report --run deepseek-recall-v2-live
```

The packet contains opaque shuffled case IDs, the question/rubric, allowed prefix, actual original delivery receipts
and the exact raw answer. It excludes arm/model labels, API spend, timing and episode order. Receipt origins and
self-identification inside an unmodified answer may reveal the search factor; this is partial blinding, not a claim
that configuration is impossible to infer. Prefix content is evidence and never reviewer instructions. Files stay
mode 600 under `blind/`; keep the `.mapping.json` private from reviewers. Re-exporting the same name reuses the
sealed packet; use `stage-32` after the second cutoff. Votes already recorded for cutoff 22 must not be recreated.

The template has deliberately blank vote ID/reviewer/rationale/timestamp fields and cannot be imported unchanged.
`kind` is `machine`, `human` or `adjudication`; reviewer identities must be independent. `score` separates factual
correctness, evidence completeness/validity, abstention and unsupported content. `evidenceIds` are originals cited
by the answer, not sources the grader read privately. `searchSupported` requires a cited delivered search/read
receipt. Machine grading is an explicit local reviewer step; the packet/export/import commands do not call a judge
API or allocate hidden judge spend. Reviewer identity/kind is an attestation, not authenticated proof of a human.
When the rubric requires abstention and no claims, absence of factual citations is valid; positive factual answers
still require cited originals for complete evidence. Review changes never rewrite the recorded strict scores.

Votes append to `semantic-reviews.jsonl` and bind packet/run/source/corpus/result identity. Exact duplicate vote IDs
are idempotent; altered IDs/content, changed answers, duplicate vote kinds and out-of-prefix evidence are rejected.
Both machine and human votes must exist. Agreement resolves the case; disagreement remains pending until a human
adjudication vote names both disputed vote IDs in `resolves`. Preserve both initial votes. A machine-only review is
diagnostic. Semantic recall may pass for meaningful prose or malformed JSON, while strict format still fails.
Semantic passing requires factual correctness, correct abstention, no unsupported claims and a completed safe
execution; evidence passes separately. Strict passing additionally requires the original parsed answer and all
evidence/abstention checks. No JSON repair or strict-result rewrite occurs.

Reports expose both memory effects (with search off/on) and both search effects (within each memory), paired gains,
losses, strict/semantic/evidence/abstention/format counts, review disagreement, all planned-answer coverage and stage
receipts. Reader metrics retain attempts/retries, returned tool bytes, denials, reported/charged/cache/reasoning
tokens and timing coverage. Shared construction is counted once per memory, with input/output/attempt amortization
per planned and completed answer across both consuming arms. Warm reuse is labelled; it is not a cold-build price.
Semantic efficiency uses human-resolved passes and all charged reader work, including failures. Zero-pass cost per
pass, missing prices and unmeasured timing remain unknown.

A comparison is promising only after the entire four-arm plan has completed with resolved human scores, at least
two paired semantic gains, zero losses, candidate abstentions passing and candidate evidence valid/complete. Every
search gain must be supported by cited original search/read evidence. Ties establish no benefit. The corpus is a
small, previously examined development sample: do not claim statistical/model superiority or promote a production
policy from it. Review omissions, distortions, retrieval misses, stale state, reader reasoning, redaction,
provider failures and grader ambiguity in vote rationales before changing one factor in a fresh experiment.

Only credible recall findings justify the next continuation experiment: fresh real checkpoints in disposable code
snapshots, a real next owner request, bounded tools/API use, and acceptance based on the resulting diff and actual
repository checks. Plan that experiment separately; recall correctness alone does not prove successful coding
continuation or authorize deployed writes.
