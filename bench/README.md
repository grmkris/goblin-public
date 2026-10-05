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
Private session import, executable continuation, deployed load and autonomous tuning are later extensions.
