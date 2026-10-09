# Cross-chat retrieval spike (2026-10-08)

This is a deterministic, synthetic owner history: 25 overlapping subjects, 120 chats (primary, thread, and subagent variants), 3,000 messages, and 80 hand-checked labels. The committed [generator](scripts/retrieval/generate.py) recreates both messages and labels in the ignored `.local/bench/retrieval/corpus.json`; test setup and the live coordinator verify the original committed checksum before use. Its frozen SHA-256 is `6c750e41b0aa29ce6fb1c65c191686bad6d1ddc9fc273d07f491b0ea76e7fcd3`. It has 25 exact-term, 25 paraphrase, 20 superseded-state, and 10 absent queries. The generator used no model calls. Labels refer to exact chat and entry ranges and were checked against the fixture before indexing.

The immutable manifest and dry-run estimate are kept in the private `.local/bench/retrieval/` ledger. The plan reserved at most 3,000 inference requests, 8,000,000 input tokens, 120,000 output tokens and $3.00; the dry run estimated 494 requests and at most $2.01 using dated public prices for Workers AI/Clef and a conservative local-model estimate. The append-only ledger recorded 81 inference attempts (80 cheap rerank calls and one Clef permission response), 90,114 input tokens, 1,310 output tokens, and an estimated $0.0095354 for CLIProxy rerank. CLIProxy provider billing is not observable here, so that number uses reported tokens and the public Gemini 2.5 Flash-Lite rates ($0.10/M input, $0.40/M output), not a bill.

## Arm A: native Durable Object FTS5

The native workerd probe passed: FTS5 is available; `trigram` is available; `bm25()` returns ranked rows; shadow tables are `app_transcript_fts_config`, `app_transcript_fts_data`, `app_transcript_fts_docsize`, and `app_transcript_fts_idx`; and the same raw SQL statement-breakpoint migration path used by goblin's Drizzle migrator applied a scratch migration twice. The production migration list was not changed. Inserts, updates, deletes, bounded excerpts, and trigger synchronization were exercised in the native worker.

The index uses application tables only: `app_transcript_excerpts`, its `(chat_id, entry_id)` index, `app_transcript_fts`, and `app_transcript_index`. Text is JSON-field redacted and bounded with the same 12,000-character head/tail policy as runtime memory logging. Query terms are literal Unicode tokens (up to 32) joined with `OR`; ranking is `bm25` ascending with `at` and `entry_id` descending as recency tie-breaks. This prevents a query from injecting FTS operators.

| label set          | queries | recall@5 | recall@10 |   MRR | absent correct |
| ------------------ | ------: | -------: | --------: | ----: | -------------: |
| exact              |      25 |   100.0% |    100.0% | 1.000 |            n/a |
| semantic           |      25 |    68.0% |     72.0% | 0.554 |            n/a |
| superseded         |      20 |    80.0% |     85.0% | 0.703 |            n/a |
| absent             |      10 |      n/a |       n/a |   n/a |           0/10 |
| positive aggregate |      70 |   82.86% |    85.71% | 0.756 |            n/a |

Native workerd query time was a local measurement, not production latency: median 4 ms, mean 3.81 ms, p95 7 ms across 80 queries. Indexing wrote 9,240 cursor rows for 3,000 messages (3 rows per message plus 240 session checkpoints). The final database was 847,872 bytes from a 36,864-byte empty baseline, or 270,336 incremental bytes per 1,000 messages. FTS shadow-table row counts were data 57, idx 55, docsize 3,000, config 1; FTS5 segment rows are implementation details and are not a message count. `rowsWritten` is the Durable Object cursor billing counter, not a claim that each row is billed identically in production.

| after cheap rerank      | recall@5 | recall@10 |   MRR | non-empty macro precision |
| ----------------------- | -------: | --------: | ----: | ------------------------: |
| exact (25)              |   100.0% |    100.0% | 1.000 |                     98.0% |
| semantic (25)           |    72.0% |     72.0% | 0.720 |                    89.47% |
| superseded (20)         |    85.0% |     85.0% | 0.850 |                    86.84% |
| positive aggregate (70) |   85.71% |    85.71% | 0.857 |                    92.06% |

Recall is macro over distinct target ranges and MRR over positive queries; negatives have a separate abstention measure. Precision is macro over 63 non-empty selections out of 80, with empty selections excluded and their recall still counted as misses; micro precision is 91.34% (116/127 selected entries). An alternate but semantically equivalent message outside a labelled range counts as a false positive. Labels are not an independent human evaluation. The repetitive checklist messages make this a controlled diagnostic corpus, not representative production chat diversity.

The cheap constrained JSON rerank was applied to Arm A's top 20. It returned valid IDs for all 80 queries, raised positive recall@5 to 85.71% and MRR to 0.857, with macro non-empty precision 92.06%; all ten absent queries abstained. Median latency was 600.48 ms and p95 704.95 ms from this box through CLIProxy. It has no provider-side cost receipt.

## Arm B: Vectorize + Workers AI

This section records the first run, where Arm B was blocked; the measured Arm B is in [the 2026-10-09 run](#arm-b-hybrid-and-clef-2026-10-09).

Arm B was designed behind injected `EmbeddingApi` and `VectorizeApi` providers, including dimension validation, per-owner namespace, and `finally` deletion. The live account probe returned HTTP 403 for Vectorize index listing and Workers AI catalog/schema. No index was created, and cleanup confirmed there was no index to delete. The lane records this as a permission boundary; it does not infer recall, latency, dimensions, or cost for a blocked arm. Public model documentation identifies `@cf/baai/bge-m3` at $0.0118 per million input tokens; its dimensions could not be verified through the account API. The provider client is ready to use a scoped `CLOUDFLARE_AI_TOKEN` when the conductor supplies one.

The planned operational shape is one `goblin-spike-retrieval` index, one namespace per synthetic owner, batched embeddings, top-20 queries, and deletion in a `finally` block. Vectorize pricing documentation gives first 50M queried dimensions and first 10M stored dimensions included on Workers Paid, then $0.01 per million queried and $0.05 per 100M stored dimensions. At the unverified planned dimension count of 1,024, 1,000 messages would occupy 1.024M stored dimensions: a $0.000512 monthly storage estimate beyond included allowances, plus $0.01024 for upsert dimensions. Embedding cost per 1,000 messages and live REST latency remain unmeasured. Multiplying the frozen excerpt bytes/4 by $0.0118/M gives only a token-heuristic estimate; actual Workers AI usage is needed before claiming an embedding cost. Shared-account included allowances cannot be assumed unused. No storage charge occurred in this trial.

## Rerank and hybrid decision

Clef's public schema supports one `noul` question per candidate plus a `none_relevant` question. The live request returned HTTP 401 with the current token, so Clef was skipped and no Clef quality claim is made. The cheap rerank validates every returned ID against the top-20 set, rejects duplicates/foreign IDs and requires `none` to agree with an empty ID list. Current private rerank receipts retain selected IDs, validity, and latency; the native receipt binds candidates to the canonical fixture hash. The richer source-strip receipt below is a proposed production contract, with a pure-function regression.

The evidence shape for Goblin's answer source strip is one record per source: `chatId`, `sessionId`, `entryStart`, `entryEnd`, bounded redacted `excerpt`, `retrievedAt`, `indexRevision`, and `score`. The source strip should show the captured excerpt delivered to the answer, while the durable transcript remains the source of truth. A changed source therefore leaves an inspectable historical receipt and its revision rather than silently changing what the answer used.

A hybrid policy should be considered only after a permitted Arm B run: union FTS and vector candidates, deduplicate by entry ID, then apply one constrained rerank. On these local results, FTS is already exact (100% recall@5) and cheap; the semantic gap (68% recall@5) is the reason to test vectors, not evidence to deploy them. If vectors improve paraphrase recall without increasing stale-state hits or deletion burden, hybrid is the likely product choice. With Arm B unavailable, this spike recommends Arm A as the deployable baseline: it is local, fast, inspectable, has no external index lifecycle, and provides exact-term recall. It still requires a relevance/abstention gate: bare FTS returned candidates for all ten absent queries. Start a fresh permission-enabled receipt with the same frozen corpus, prompts and remaining cumulative budget before deciding whether hybrid earns its operational cost.

## Validation boundary

`bench/test/transcript-index.test.ts` is native workerd proof. `bench/test/transcript-unit.test.ts` covers fixture integrity, range scoring, Unicode query escaping, source receipts, injected Vectorize cleanup, and rerank schema rejection. `bench/scripts/retrieval/test_budget.py` covers append-only reservations, torn-ledger fail-closed behavior, reported-usage breaches, permission denials, and Clef question shape. `bench/scripts/retrieval/test_generate.py` verifies identical generated/stdout bytes, the frozen SHA-256, and rejection of checksum drift before writing an artifact. The unit test also pins the raw and canonical corpus hashes. `heavy bun run check` passed locally with `GOBLIN_HARNESS_PORT=19201` after the root and three standalone frozen dependency installs: zero lint/Effect/Knip findings, all unit/native integration suites and the build. These gates make no live model calls and do not prove permission-enabled Arm B or Clef acceptance.

Public sources consulted on 2026-10-08: [DO SQLite](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [BGE-M3 catalog](https://developers.cloudflare.com/workers-ai/models/bge-m3/), [Clef schema](https://developers.cloudflare.com/workers-ai/models/clef/), [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing). Model-catalog examples and raw schemas differ for BGE-M3 (`text` versus `contexts`); the blocked client uses the current `contexts` schema but has no permitted embedding acceptance receipt.

For a product integration, enumerate only the owner's active Topics at admission and recheck their active state before returning excerpts. This fixture treats all 120 chats as active; it does not prove archived-topic filtering. Keep per-session through-entry checkpoints, a revision covering source edits/deletions and redaction policy, and backfill in short batches. FTS candidate scores must record their direction (lower BM25 is better); vector similarity has the opposite direction and cannot be numerically mixed without calibration. A source receipt should additionally include the excerpt hash and redaction version. User erasure must remove the local rows (the FTS delete trigger removes postings), external vector IDs/namespaces and captured source-strip excerpts; content-free cost receipts can remain under the declared retention policy. Deletion confirmation and a tombstone fencing in-flight upserts are needed before erasure is complete. Those lifecycle cases are design requirements, not measured provider proof in this spike.

## Arm B, hybrid and Clef (2026-10-09)

A second, permission-enabled run (`retrieval-20261009-v2`, coordinator [`hybrid.py`](scripts/retrieval/hybrid.py))
used the same frozen corpus (SHA-256 verified before every command), the same 80 labels, Arm A's recorded FTS
candidates, and the same rerank prompt and model as the first run. Its immutable manifest, dry run, append-only ledger
and every provider response are in the private `.local/bench/retrieval/20261009/`. The dry run reserved at most 574
requests and $0.64 against a $1.00 ceiling; no call was retried. The scoring reproduces the first run's Arm A numbers
exactly (82.86% / 0.756 raw, 85.71% / 0.857 / 92.06% after the cheap rerank), so the two runs compare.

- **Arm B** embedded the 3,000 messages and 80 queries with `@cf/baai/bge-m3` (1,024 dimensions; the REST response
  carries the vectors under `response`, with `data: null`) into the throwaway Vectorize index `goblin-spike-retrieval`
  (cosine, one namespace), queried the top 20, and deleted the index in a `finally` block; a read after the delete
  returned HTTP 410. All 3,000 vectors were visible about 208 s after the index was created.
- **Hybrid (H)** fuses Arm A's and Arm B's top 20 by reciprocal rank (k = 60) and keeps the fused top 20.
- **Reranks:** the cheap constrained-JSON rerank (CLIProxy `gemini-2.5-flash-lite`, temperature 0) on B and H (A's is
  the first run's), and Clef (`@cf/cloudflare/clef`, one `noul` question per candidate plus `none_relevant`, threshold
  0.5) on A, B and H. Every cheap answer was valid JSON citing offered ids.

| arm              | recall@5 | exact | paraphrase | superseded |   MRR | precision | absent abstained |
| ---------------- | -------: | ----: | ---------: | ---------: | ----: | --------: | ---------------: |
| A (FTS) raw      |    82.9% |  100% |      68.0% |      80.0% | 0.756 |      8.6% |             0/10 |
| B (vector) raw   |    84.3% |  100% |      68.0% |      85.0% | 0.786 |      8.9% |             0/10 |
| H (fused) raw    |    87.1% |  100% |      76.0% |      85.0% | 0.813 |      9.4% |             0/10 |
| A + cheap rerank |    85.7% |  100% |      72.0% |      85.0% | 0.857 |     92.1% |            10/10 |
| A + Clef         |    84.3% |   96% |      72.0% |      85.0% | 0.781 |     74.3% |            10/10 |
| B + cheap rerank |    90.0% |  100% |      76.0% |      95.0% | 0.890 |     89.1% |            10/10 |
| B + Clef         |    87.1% |   92% |      76.0% |      95.0% | 0.805 |     81.8% |            10/10 |
| H + cheap rerank |    94.3% |  100% |      84.0% |     100.0% | 0.943 |     92.2% |            10/10 |
| H + Clef         |    92.9% |   96% |      84.0% |     100.0% | 0.843 |     76.8% |            10/10 |

Recall is macro over labelled target ranges of the 70 positive queries (25 exact, 25 paraphrase, 20 superseded); raw
arms are scored on their full top 20 and reranked arms on their selection in order; precision is over selected
entries. Latency from this box over REST (not a Worker binding): query embedding median 113 ms (p95 170), Vectorize
query 282 ms (p95 354), cheap rerank 541 ms (p95 645), Clef 680 ms (p95 1,030).

Spend: the ledger charged $0.444, conservatively (Clef and embeddings at their byte-based reservations, the cheap rerank
at its reported usage). Reported usage was 101,487 bge-m3 tokens (about 33,000 per 1,000 messages, $0.0004 per 1,000
at $0.0118/M), 178,027 input and 2,771 output tokens for the cheap rerank ($0.019 at $0.10/$0.40 per M, about
$0.00012 per query), and 749,545 Clef input tokens ($0.18 at $0.24/M, about $0.00075 per query): about $0.20 at public
prices. 3,000 stored and 3,080 × 1,024 queried dimensions are inside Vectorize's Workers Paid allowances. None of
these is a provider bill.

**Decision: hybrid is worth it, as the next step.** Fused candidates with the same cheap rerank lift recall@5 from
85.7% to 94.3% (paraphrase 72% to 84%, superseded 85% to 100%) at the same precision and abstention, and embeddings cost
almost nothing. What hybrid adds is operational: an external index per owner (a namespace, upserts from the indexing
catch-up, deletion and a tombstone on erasure), about 0.4 s more per automatic retrieval from this box, and
re-embedding if the model changes. The shipped path stays Arm A (FTS5 in the Durable Object) with the cheap rerank
(ADR 0035); hybrid is a follow-up through Worker bindings (Workers AI and Vectorize), with its latency measured there.
Clef is not worth it here: below the cheap rerank on every arm (it missed exact-term targets and ranked less
precisely), at about six times the per-query cost and with higher latency. These are synthetic, single-run results
with labels written alongside the corpus; they rank the options, not production recall.
