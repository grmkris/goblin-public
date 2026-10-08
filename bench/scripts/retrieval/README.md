The cross-chat spike is independent of the Pi compaction benchmark. The committed `generate.py` recreates the
synthetic messages and all 80 hand-authored labels without model calls. It verifies `bench/fixtures/retrieval/corpus.sha256`
before publishing `.local/bench/retrieval/corpus.json`; it never rewrites the frozen checksum. Test setup and the
live coordinator use this same generator. Run `python3 -B bench/scripts/retrieval/generate.py` from the repository
root to generate the ignored fixture, or use `--stdout` for the verified JSON bytes.

`live.py plan` seals a private manifest and dry run before any AI call. `live.py rerank` uses the native candidates,
with a sequential, append-only budget ledger and no automatic retries. Provider responses remain in `.local/bench/retrieval/`.
The conductor's optional `CLOUDFLARE_AI_TOKEN` is preferred over `CLOUDFLARE_API_TOKEN`; CLIProxy reads `CLIPROXY_API_KEY`.
All credentials come from environment variables. See the spike report for measured results and limits.
