# Coding spike

An external MCP server lets Goblin on dev edit `grmkris/goblin` and return a draft pull request without deploying
changes to the Goblin Worker. The trusted host prepares one committed snapshot and installs its frozen dependencies
once. Each coding session has an in-memory text overlay and native verifier processes; repeated checks reuse them.
Private checkpoints recover overlays and publication intent after a server restart.

The seven tools are `coding_open`, `coding_read`, `coding_search`, `coding_edit`, `coding_ready`, `coding_submit` and
`coding_close`. Open takes a stable `operationId`. Edits take the current revision and replace one file. Ready checks
the CLI project with the pinned TypeScript and Effect compilers, type-aware Oxlint and Oxfmt, using virtual files and
unsaved LSP documents. Submit requires an unchanged, successful revision and creates a draft PR on a deterministic
branch. Retry reconciles that branch and PR. It never merges or deploys.

## Scope

- Only `apps/cli/src/**/*.ts` and `apps/cli/test/**/*.ts` can change. No deletion, dependency or configuration edits.
- Eight files and 150,000 characters per overlay; four retained sessions and one verifier request at a time.
- Source comes from a committed Git archive, never another agent's dirty checkout. Reads are limited to bounded
  tracked text files and the overlay. Nothing exposes the host shell or credentials to the agent.
- Native verifiers run on the trusted Netcup host with a scrubbed environment. They parse source and trusted snapshot
  configuration; they do not execute agent edits. This is not a container sandbox for running arbitrary code.
- Ready proves scoped static checks. It does not run tests, build the monorepo, execute edited code or use a browser.
  GitHub CI and human review remain necessary before merge.
- OAuth requires the exact dev callback, PKCE and operator authorization. Stored token material is hashed, and private
  files are mode 600. A quick tunnel is temporary; restarting it with a different URL requires reconnecting Goblin.

## Run

From the repository root, install with `cd spikes/coding && bun install --frozen-lockfile`. Run `bun run snapshot`
once in that directory. It creates `.local/coding-spike` in the repo root with the archive, dependencies and private
configuration. Keep the directory private; do not print `config.json` or `oauth.json`.

For verification, run `bun run typecheck`, scoped root Oxlint/Oxfmt, and `heavy bun test test` in this package. The
native regression requires the prepared snapshot. Run the root `heavy bun run check` before handing off changes.

Start from the repository root with `bun spikes/coding/scripts/server.ts .local/coding-spike/config.json`. It binds
loopback port 18983. A private tmux session can retain this temporary service; do not install a permanent host unit.
Expose that port with an HTTPS Cloudflare tunnel, put its origin in the private config, and restart the server.

Add the HTTPS `/mcp` endpoint to Goblin's dev connections. Complete its authorization URL through an operator script
that sends the private admin key as an Authorization header and follows the returned callback with the owner's dev
session. Grant exactly the seven tools. Never put the admin key or callback code in a chat message or log.

Use a dedicated chat thread to request the CLI Hello World feature. Restrict that conversation to the coding connection.
Inspect the draft PR and scoped validation receipt before merging. Stop the owned server and tunnel tmux sessions and
remove the connection when the spike ends. Stopping does not delete private checkpoints or published draft PRs.
