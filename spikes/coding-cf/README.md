# Cloudflare coding verifier spike

This is the second runner for the coding spike. It keeps the MCP service and GitHub publisher on the trusted host,
but moves `coding_ready` and the fixed `goblin hello` execution into a per-job Cloudflare Container.

The Worker authenticates requests with `RUNNER_TOKEN`, derives container names from the job ID, and forwards only
`/verify`, `/execute`, and `/close`. The container starts from a frozen Goblin snapshot with dependencies installed in
the image. It has `enableInternet = false`, so neither the verifier nor edited code can reach the network. The
container receives no GitHub, model, Cloudflare, or host credentials. Verification reuses the job's compiler processes;
fixed execution uses a separate container, destroyed after its response.

This is intentionally an operator spike, not the third-party product boundary. The token is one operator secret and
the repo fixture is the current `grmkris/goblin` snapshot. A production version must derive a container ID from the
authenticated Goblin user and repository, use a GitHub App installation token only in a Worker-controlled outbound
request, and destroy the container after the task.

## Run and deploy

1. Prepare the first spike snapshot: `cd spikes/coding && bun run snapshot`.
2. In this directory, run `bun install --frozen-lockfile` and `bun run image:prepare`.
3. Keep `GOBLIN_CODING_RUNNER_TOKEN` in the mode-600 private environment used for the deployment.
4. Deploy the isolated dev stack from the repository root:
   `bun node_modules/alchemy/bin/alchemy.js deploy --config spikes/coding-cf/scripts/stack.ts --stage dev --yes --no-input`.

The first deployment builds and uploads the image; subsequent deployments use the Cloudflare image cache.
`GET /health` checks the Worker. `POST /verify?job=<64-hex-session-id>` runs the same TypeScript, Effect,
Oxlint, and Oxfmt checks as the Netcup spike. `POST /execute?job=<id>` runs only `goblin hello`. Both take
`{"base":"<40-hex-base>","session":"<64-hex-session-id>","revision":"<64-hex-revision>","changes":[["apps/cli/src/main.ts","..."]]}`.
`POST /close?job=<id>` destroys the verifier and execution containers.

## Connect a parallel coding service

The existing `spikes/coding` MCP server accepts an optional private configuration field:
`"runner": { "endpoint": "https://<deployed-worker>", "token": "<private-runner-token>" }`.
Copy its mode-600 configuration to a separate mode-700 state directory, give it a distinct loopback port and a new
operator admin key, and copy `files.json` into that directory. Keep the same frozen `root` and `base` as the image.
This service keeps its own OAuth, session and publication checkpoints; the original Netcup connection can stay live.

Start the server with that configuration, expose its loopback port with a temporary HTTPS tunnel, update its private
`origin`, and restart it. Connect and authorize it on Goblin dev using the same OAuth/PKCE procedure documented in
`spikes/coding/README.md`, grant the seven coding tools, and restrict a dedicated chat to this connection.
`coding_ready` now calls the Cloudflare verifier; `coding_submit` still publishes through the trusted host's GitHub login.
Fixed execution is an operator check, not another granted agent tool.

## Compare

`heavy bun spikes/coding-cf/scripts/compare.ts https://<deployed-worker>` compares the existing Hello World PR fixture
against Netcup on the same base and revisions. The token is read from the private
`.local/coding-cf-spike/runner.env`. It requires identical diagnostics, rejects the invalid edit, accepts the Hello and
two warm checks, and requires execution to return `Hello, world!\n` with exit code zero. Both containers are closed
afterwards. Timings and the bounded receipt go to `.local/coding-cf-spike/comparison-cloudflare.json`.

For local acceptance, start the image as a container named `goblin-coding-cf-local` and use `docker` as the comparison
target. Local Docker timings and real Cloudflare timings are separate evidence. The frozen fixture, CLI allowlist and
static-check scope are unchanged; this is not a generic repository runner or a browser testing loop.
