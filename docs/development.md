# Development

Install the Bun version in `.bun-version`, then run `bun install --frozen-lockfile`. Tests use native workerd; unit tests and native integration results are separate from deployed acceptance.

For the complete check, also install the standalone dependencies:

```sh
(cd scripts/fixtures/mcp-app && bun install --frozen-lockfile)
(cd spikes/coding && bun install --frozen-lockfile)
(cd spikes/coding-cf && bun install --frozen-lockfile)
bun run check:public
```

Copy `.env.example` to `.local/local.env`, mode 600. Set `GOBLIN_MODEL_BASE_URL` to your OpenAI-compatible provider endpoint, `GOBLIN_MODEL_ID` to an offered model and `GOBLIN_MODEL_KEY` to your own development key. The local defaults support CLIProxy, but supplying your own provider configuration replaces those defaults. Run `bun dev` for `http://localhost:18971`. Alchemy's local simulator captures OTP email in `.eml` files. Never commit local environment files, cookies or session captures.

`apps/runtime` contains the resident Agent Durable Object, MCP host, typed owner API and tests. `apps/web` contains TanStack Start and the browser conversation stream. `packages/app` owns the toolchain that the runtime bundles, including its required embedded docs. `packages/kit` and `packages/ui` supply shared views. `bench` and `spikes` are research tooling; their private inputs and run records are not included.

For a deployment of your own, create mode-600 `.local/cloud.env` with your `CLOUDFLARE_ACCOUNT_ID` and suitably scoped `CLOUDFLARE_API_TOKEN`. Set `GOBLIN_CLOUD_ENV_FILE` to override that location. Prepare separate `.local/dev.env` and `.local/prod.env` from the template, with your own origins/domains, zone, mail sender, independent encryption/auth secrets and model-limited budget-capped provider keys. Never bind a provider's master key. Cloudflare Email Sending requires sender onboarding. Local capture is not delivered-mail acceptance.

Stage commands use isolated Alchemy state and a host lock. Set `GOBLIN_RELEASE_ROOT` to a private directory you own, outside the checkout, before the first stage operation; stage state must be initialized deliberately. Use `bun run plan:dev` before `bun run deploy:dev`. Every prod command requires `GOBLIN_CONFIRM_PROD=1`. Destructive resets require `--confirm-reset` and erase stage data. These are operator tools for your own deployment; the private repository's production-promotion pipeline is not distributed here. [Publication](../PUBLICATION.md) explains how this source is released.

Goblin Wallet is a separate Worker. `bun run dev:wallet`, `bun run plan:wallet-dev` and `bun run deploy:wallet-dev` are its dev-stage entrypoints; `bun run plan:wallet-prod` and `GOBLIN_CONFIRM_PROD=1 bun run deploy:wallet-prod` target prod using mode-600 `.local/wallet-prod.env`, isolated Wallet state and its own deploy lock. Configure your own Privy application, signer policy and separate per-stage Pimlico keys. The hosted Wallet is at `https://wallet.goblin.surf`; private Promote deploys it alongside core Goblin and verifies live health, the production OAuth issuer and anonymous MCP 401. Local tests and these public probes do not prove live payments or production financial readiness. Goblin-owned code uses MIT; dependencies retain their own terms.

Application-owned Durable Object tables use `app_`. Pi and Agents vendor tables are untouched. Greenfield migration edits are not backwards-compatible: an applied schema edit needs a deliberate stage reset rather than silently repairing production. Keep SQLite transactions short and outside network/model waits.

`bun run check:fast` is the iterative gate. `bun run check:public` includes formatting, portable docs, patch/chat-ID checks, graph boundaries, type checks, spikes, lint/Effect/Knip, duplication, unit/native integration profiles and builds. Do not represent these as deployed-stage or provider acceptance.
