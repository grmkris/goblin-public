# Engineering handoff

The native Cloudflare Agent hosts Pi Durable for execution and transcript recovery. Effect composes application services. Better Auth uses an isolated D1 store, and MCP authority remains owner-bound. The browser's typed API, conversation stream and nested MCP App sandbox are separate boundaries.

The app toolchain embeds `packages/app/docs` and uses the checked-in Bun patch and its source provenance. A usable source checkout therefore includes those docs, all patches, standalone test fixtures and the quality tooling. Removing operational records alone does not justify removing build inputs.

Release evidence is scoped: deterministic tests and local native workerd checks establish local behavior; authenticated stage smoke establishes a specific deployed stage; provider and chain acceptance require separate observations. Wallet is a separate Worker deployed by private Promote from the same source SHA as core Goblin. Its public smoke and active Worker version are checked before source publication; payment and chain evidence remain separate.

The public source preserves original authorship and meaningful history. Private sessions, cloud account records, deployment logs and credential stores are excluded, and the private repository retains the production-to-public correspondence map. See [Publication](../PUBLICATION.md) for the release boundary and [NOTICE](../NOTICE.md) for licensing and upstream attribution.
