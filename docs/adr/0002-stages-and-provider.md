# Isolated stages and provider planes

Accepted 2026-10-04 from the session decisions.

`scripts/stage.ts` owns the local/dev command boundary. It scrubs inherited application/Cloudflare settings, loads
the existing mode-600 My Apps dev credentials and Purrable's separate mode-600 private settings, and invokes Alchemy.
`scripts/stage-config.ts` derives resource names and refuses production stages. Alchemy is the only deployment system.

Host coding and local provider tests use CLIProxy. A public Cloudflare Worker cannot reach the existing tailnet-only
proxy, so the user authorized public self-hosted Railway LiteLLM for Cloudflare. The dedicated `purrable-dev` key is
limited to `gemini-3.8-flash`, a $10 budget per 30 days, and a 30-day expiry. Its master key is operator-only.

Dev resources are retained for the handoff. Disposable dev fixture writes require stable operation IDs, receipts,
readback, and cleanup instructions. There is no production deployment, message sending, or destructive cleanup.
