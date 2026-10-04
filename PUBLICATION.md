# Public source

This repository publishes sanitized production source from the private Goblin development repository. Original authors and dates are retained; private configuration and operational records are excluded. Public commit IDs differ from deployment commit IDs. Issues are open for feedback; changes currently land through private development and production promotion.

A private `dev` push passes checks, deploys the daily dev instance and runs authenticated acceptance. An explicit Promote action advances `prod` to that exact SHA and verifies production. Only then does the source exporter validate this checkout and advance public `main`. Publication can be retried independently if it fails after deployment.

Goblin Wallet runs at `https://wallet.goblin.surf`. Promote deploys both core Goblin and Wallet production from the same accepted source SHA, then checks Wallet live health, the production OAuth issuer and anonymous MCP refusal. Publication requires current source/version receipts for both Workers. These public probes do not establish payment or financial-provider acceptance. Local tests, dev acceptance, production acceptance and live financial-provider evidence are separate claims.

Goblin-owned code uses MIT. See [NOTICE](NOTICE.md) for the exact ownership boundary and third-party terms. Synthetic fixtures and demo assets are not production user data.
