# Memory benchmark workspace

Native Pi memory experiments in an isolated Alchemy/workerd stack. The starter compares the full GLM 5.3 / DeepSeek
V4 Pro 0813 writer-reader matrix against Pi's own compactor and Pi plus lexical archive search: 3 development
families × 2 cutoffs × 2 probes × 8 configurations = 96 answer episodes. Three distinct families remain held out.
Model IDs are exact catalog routes: `glm-5.3`, `deepseek-v4-pro-0813`. Catalog discovery does not prove inference.

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
