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
