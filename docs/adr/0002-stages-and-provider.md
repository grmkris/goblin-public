# Isolated stages and provider planes

Accepted 2026-10-04 from the session decisions.

`scripts/stage.ts` owns the local/dev command boundary. It scrubs inherited application/Cloudflare settings, loads
the existing mode-600 My Apps dev credentials and Purrable's separate mode-600 private settings, and invokes Alchemy.
`scripts/stage-config.ts` derives physical names per stage. Production support was added on 2026-10-05 as described below. Alchemy is the only deployment system.

Host coding and local provider tests use CLIProxy. A public Cloudflare Worker cannot reach the existing tailnet-only
proxy, so the user authorized public self-hosted Railway LiteLLM for Cloudflare. The dedicated `purrable-dev` key is
limited to `gemini-3.8-flash`, a $10 budget per 30 days, and a 30-day expiry. Its master key is operator-only.

Dev resources are retained for the handoff. Disposable dev fixture writes require stable operation IDs, receipts,
readback, and cleanup instructions. There is no production deployment, message sending, or destructive cleanup.


## 2026-10-05: production stage

Prod uses separate resources and mode-600 secrets, `purrable.lol` as its canonical origin and a dedicated LiteLLM
virtual key. `dev.purrable.lol` keeps the existing dev data. Alchemy owns custom domains; Workers redirect alternate
hosts (301 GET/HEAD, 308 other methods). Prod tooling requires `PURRABLE_CONFIRM_PROD=1`. Prod smoke defaults to reads;
full acceptance needs an operator account. There is no destroy-prod command. Dev sign-up is closed or invite-only.
