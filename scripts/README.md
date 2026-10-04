# Product scripts

`bun dev` runs local core Goblin; `bun run dev:wallet` runs Wallet separately. Configuration belongs in mode-600 `.local` files and your own provider/cloud account.

Use `bun run check:fast` while changing source and `bun run check:public` for the complete public checkout gate. Install the standalone fixture and spikes first as described in [Development](../docs/development.md). The `patches/` directory and `packages/app/docs/` are build inputs and must be retained.

Core stage commands include `bun run plan:dev`, `bun run deploy:dev`, `bun run drift:dev` and `bun run smoke:dev`. Smoke needs an operator account with a real OTP session and spends model tokens. Stage health, authenticated smoke, migration inventory and live provider behavior prove different things. Production stage tools require `GOBLIN_CONFIRM_PROD=1`; destructive commands additionally require `--confirm-reset`.

The private release/promotion/export commands are not included in this distribution. See [Publication](../PUBLICATION.md) for the release flow, and [Development](../docs/development.md) to configure a deployment of your own. Private Promote deploys Wallet production alongside core Goblin; these public tools do not provide payment or financial-provider acceptance.
