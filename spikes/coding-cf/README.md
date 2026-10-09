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

1. Prepare a frozen spike snapshot: `cd spikes/coding && bun run snapshot`.
2. In this directory, run `bun install --frozen-lockfile` and `bun run image:prepare`. To prepare a separate pinned
   snapshot, run `bun scripts/prepare.ts <private-snapshot-state>`; this creates a base-specific image context.
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
`"runner": { "kind": "cloudflare", "endpoint": "https://<deployed-worker>", "credentialRef": "<private-env-file>", "imageDigest": "sha256:<manifest>" }`.
Copy its mode-600 configuration to a separate mode-700 state directory, give it a distinct loopback port and a new
operator admin key, and copy `files.json` into that directory. Keep the same frozen `root` and `base` as the image.
This service keeps its own OAuth, session and publication checkpoints; the original Netcup connection can stay live.

Start the server with that configuration, expose its loopback port with a temporary HTTPS tunnel, update its private
`origin`, and restart it. Connect and authorize it on Goblin dev using the same OAuth/PKCE procedure documented in
`spikes/coding/README.md`, grant the seven coding tools, and restrict a dedicated chat to this connection.
`coding_ready` now calls the Cloudflare verifier; `coding_submit` still publishes through the trusted host's GitHub login.
Fixed execution is an operator check, not another granted agent tool.

## Compare

`heavy bun spikes/coding-cf/scripts/compare.ts <immutable-image-reference> https://<deployed-worker> <private-snapshot-state>`
compares the existing Hello World PR fixture on native, Docker and Cloudflare with the same base and revisions. The token is read from the private
`.local/coding-cf-spike/runner.env`. It requires identical diagnostics, rejects the invalid edit, accepts the Hello and
two warm checks, and requires execution to return `Hello, world!\n` with exit code zero. Both containers are closed
afterwards. Timings and the bounded receipt go to `.local/coding-cf-spike/comparison-cloudflare.json`.

For local acceptance, start the image as a container named `goblin-coding-cf-local` and use `docker` as the comparison
target. Local Docker timings and real Cloudflare timings are separate evidence. The frozen fixture, CLI allowlist and
static-check scope are unchanged; this is not a generic repository runner or a browser testing loop.

## 2026-10-09 refreshed image and dev receipt

The Cloudflare stack was rebuilt from the frozen base `23eec4e8ee5d92d54d583bf6846d0b117076b1e2` and deployed to the dev
Worker. The pulled immutable image is
`sha256:eef4a6202fd4c115b026c0b9985cc8edeb900faac0c14cc647b5fc8751d5b9ef`; Docker comparison uses that same reference.
The repeated three-backend comparison passed the invalid edit, corrected fixture and two warm checks with normalized
diagnostics, and all fixed execution receipts returned `Hello, world!\n`.

The named dev tunnel stack is in `scripts/tunnel.ts` and is guarded to the dev stage. The current Cloudflare token lacks
Tunnel edit scope, so the accepted dev connections use three private quick tunnels recorded in the lane handoff. Each
has its own tmux session and private origin configuration. Production connection codes are minted through each live
service's serialized OAuth state and are stored under `.local/coding-runner` with mode 600.
