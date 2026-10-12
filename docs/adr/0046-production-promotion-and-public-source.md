# ADR 0046: Private development, deliberate production promotion and public source

Accepted 2026-10-12 with the owner.

## Problem

Manual deployments from private main do not make the daily environment or public submission source track a verified release. Publishing the private repository would expose agent configuration, operational records and historical private identifiers, and its persistent runner must not execute public PR code.

## Decision

Private `grmkris/goblin` stays authoritative. Daily changes land on `dev`; successful exact-tip push checks automatically deploy and verify dev with authenticated smoke. The explicit Promote action accepts one full SHA, requires its passing dev push check and current authenticated dev receipt/version, advances `prod` by fast-forward and deploys/verifies that SHA directly. GitHub-token pushes do not trigger another Actions run. Existing stage resources, state directories, host locks, non-destructive plan checks, migration inventory and reset consent remain in force.

After prod verification, project sanitized meaningful history into a separate `grmkris/goblin-public` repository with one main branch and Issues. Create new Git objects; never mirror refs, copy the original object database or export ignored worktree files. Preserve original dates, authors and emails. Remove private agent configuration and operational evidence from all projected history and sanitize private references in technical documents and messages. Keep required product source, Wallet source, manifests, fixtures, patches, assets, migrations and public build/check tooling. Reviewed technical summaries replace original private handoffs.

Validate the exact public checkout with frozen installs and the applicable full gates. Scan complete projected history and enforce dependency applicability: unknown applicable high/critical findings block publication. Public checks run on hosted runners with read-only credentials. Cross-repository writes use a destination-only deploy key in private CI. Keep the source-to-public map and production receipt privately. Reject public divergence and source rewinds; advance public main only by fast-forward. Contributions begin through Issues, with changes integrated privately.

A failed export does not roll back production. Retry publication against the same current accepted prod SHA and live version. Create the first destination privately; change visibility only after complete review and validation.

Core Goblin-owned code is source available under PolyForm Noncommercial 1.0.0. The three Wallet workspaces (`apps/wallet`, `apps/wallet-web`, `packages/wallet`) use MIT, with workspace LICENSE files and package declarations. Preserve third-party notices and same-owner MyApps/Sidequest attribution. React Leaflet's Hippocratic-2.1 terms remain disclosed. Promote deploys core Goblin and Wallet production from the same accepted source snapshot. Wallet uses `GOBLIN_CONFIRM_PROD=1 bun run deploy:wallet-prod`, its existing state and wallet deploy lock, and the mode-600 `.local/wallet-prod.env` materialized from the private prod environment secret `GOBLIN_WALLET_PROD_ENV`. It requires live health, the production OAuth issuer and anonymous MCP refusal, then records the active Wallet Worker version. Publication requires current acceptance receipts for both Workers. These public probes do not establish payment or financial-provider acceptance.

## Consequences

Public and private commit hashes differ. The private correspondence map is required for incremental export and recovery, and public main must not acquire independent commits. Original personal author emails remain public by the owner's decision. Historical projected commits preserve engineering provenance; only the exported release tip receives complete checkout validation.

Production ref advancement can precede a failed deployment. The accepted receipt and live Worker version, rather than the ref alone, decide whether source may be published. An applied migration edit still requires the explicit greenfield reset procedure; automation cannot silently destroy a stage to make a release pass.
