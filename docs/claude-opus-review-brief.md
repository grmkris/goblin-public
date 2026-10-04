# Claude Opus 5.5 review brief

Prepared 2026-10-04 for an independent review of the Purrable implementation on `main`.

## Review target

Purrable is a resident personal-agent workspace built around Cloudflare Agents, Pi Durable, MCP, and Alchemy. The intended first implementation was the workspace foundation, a native resident agent, authenticated MCP access to MyPlan and MyBrowser, AG-UI/MCP Apps surfaces, compatibility evidence, and a real retained Cloudflare dev smoke. The implementation is deliberately a core vertical slice; it is not a production promotion or a claim that every MCP or Cloudflare beta feature is supported.

The implementation is in commits `09a6e56` (runtime, MCP host, quality foundation) and `4ccd100` (deployment evidence and handoff). The final review brief is the only change after those commits.

## What was implemented

### Workspace and quality foundation

- Bun 1.4.2 owns a small Bun/Turbo workspace. Turbo schedules work; it is not a second deployment system.
- My Apps quality families were brought in immediately: Oxfmt, Oxlint, Effect diagnostics, Knip, duplication checks, graph checks, provenance checks, documentation checks, and CI.
- The implementation starts with no accepted lint, Effect, or Knip findings and no copied My Apps legacy baseline.
- Fourteen repository skills are available to fresh Codex and Claude catalogs: AG-UI/MCP Apps, Alchemy, Cloudflare Agents, documentation verification, Drizzle DO, Durable Objects, Effect 4, MCP host, OXC quality, Pi Durable, runtime tests, TanStack Start, Workers best practices, and Wrangler.

### Native Cloudflare/Pi runtime

- `PersonalAgent extends Agent` and registers the native `PiHarness` through the Agents SDK lifecycle.
- Pi Durable owns transcripts, tasks, submissions, recovery, and execution state.
- Application code owns only `app_metadata` and its migration journal. Drizzle never adopts or migrates Agent/Pi/vendor tables.
- The small Effect `AppMetadata` service provides typed application metadata access with short SQLite operations. Model calls, network waits, and lifecycle gates do not run inside application transactions.
- A separate two-process local workerd proof disposes and reconstructs the native Agent, reads the same transcript, and preserves receipt deduplication.

### Authenticated MCP host and resident tool use

- Better Auth uses `mcp()` and `jwt()` in a separate D1 auth/grants store. The pinned Durable SQLite adapter was not compatible with the required Better Auth async transaction and affected-row behavior.
- The implemented first host is the authenticated `/api/mcp/*` gateway. It is not a standalone public `/mcp` protocol server.
- The Streamable HTTP MCP client supports initialization/version negotiation, capability-gated discovery, pagination, structured and rich results, bounded result sizes, reconnect, timeout/abort forwarding, and exact capability grants.
- Grants bind the authenticated principal, configured server identity, and specific capability/tool/resource. Remote annotations and content are untrusted data and do not grant authority.
- A resident Pi registry exposes `mcp_list` and `mcp_call`. Each execution rereads the owner session and live grant before opening the outbound connection. MCP credentials stay in private bindings and manager closures.

### Web and MCP Apps

- TanStack Start serves the web surface; AG-UI projects committed Pi snapshots and live events and reconnects through a fresh snapshot.
- MCP Apps render only through the originating authorized connection.
- The MyPlan App resource is checked for exact `ui://` URI, MIME, owner, server, and grant boundaries, then rendered in nested opaque `allow-scripts` frames with CSP. App-only tools are hidden from the ordinary picker.
- The accepted App interaction forwarded the read-only MyPlan `panel_browse` call through the originating connection.

### Infrastructure and model plane

- Alchemy is the sole infrastructure/deployment authority. It declares the Worker, native Agent Durable Object binding, static assets, and isolated D1 auth database.
- Local coding and local provider probes use CLIProxy.
- The public retained Cloudflare dev Worker uses the authorized self-hosted Railway LiteLLM route, with a dedicated `purrable-dev` Gemini Flash key limited to the selected model and capped at $10 per 30 days. The LiteLLM master key is never bound to the Worker.
- No production resource or production endpoint was promoted.

## What was verified

The canonical gate passed in the main checkout and in a temporary clean frozen-lockfile copy:

- `TURBO_FORCE=true heavy bun run check`
- five workspace typechecks;
- 84 unit tests;
- two default native workerd integration tests;
- a separate native reconstruction run with two write-process tests and three read-process tests;
- zero lint findings and zero collector failures;
- zero duplication clones;
- Effect diagnostics and Knip passed;
- production web build passed;
- clean frozen-lockfile installation passed without copying secrets or caches.

The retained dev deployment is:

https://purrable-dev.kristjan-grm11775.workers.dev

The real read-only dev smoke passed at 2026-10-04 01:10:45 UTC. It covered owner sign-in, an agent snapshot, MCP registry and grants, authenticated MyPlan and MyBrowser discovery/read calls, and a resident Pi submission through the Railway LiteLLM route. The two current smoke endpoints negotiated MCP revision `2026-07-28`; the receipt recorded 22 MyPlan tools and 35 MyBrowser tools. The resident call executed MyPlan `myplan_open`, persisted a successful `pi.tool-result`, and returned the exact `PURRABLE_MCP_OK` marker.

The authenticated Chromium Apps smoke passed at 2026-10-04 00:52:22 UTC. It rendered the real MyPlan `ui://myplan/panel.html` resource in nested opaque frames, confirmed CSP and fallback behavior, kept the app-only tool hidden from the normal picker, and completed one read-only `panel_browse` call. The host permits this owner-only App HTML up to 16 MiB; ordinary model/tool results remain capped at 1 MiB. The observed MyPlan panel is about 13.3 MiB.

Receipts are sanitized and contain no access tokens, cookies, passwords, private remote note content, or model-provider keys:

- verification receipt
- deployment/source association
- retained dev smoke
- native reconstruction
- resident Pi/MCP acceptance
- browser/MCP Apps acceptance
- skill discovery

## What was deferred or remains unproven

These are explicit scope boundaries, not silently accepted support claims:

- Cloudflare MCP Portals, Durable Streams, and Tmux integration.
- Production promotion and production lifecycle behavior.
- A standalone inbound OAuth login/consent product UI and a standalone `/mcp` protocol server.
- MCP subscriptions, completion, elicitation/`input_required`, Tasks, Skills, and draft Events/Triggers.
- Remote eviction proof, in-flight alarm recovery, conversation deletion, and load testing of alarm/model-call limits.
- Provider-side cancellation guarantees and authenticated provider acceptance for those paths.
- Fresh-client skill discovery for Grok, Cursor, and Hermes.
- The official Claude skills page review: `https://code.claude.com/docs/en/skills` returned HTTP 403; the installed Claude catalog was verified instead.
- Production MyPlan/MyBrowser receipts, production browser sessions, provider-spending actions, messages, purchases, or other external mutations.

The local fixture and reconstruction prove local behavior through public APIs. They do not prove remote eviction, Cloudflare production behavior, exactly-once external effects, or provider behavior that was not exercised. `mcp_call` is treated as replay-unsafe even though durable receipts and operation IDs are recorded. PiHarness and Alchemy are beta; Pi Durable is experimental; Drizzle is a release candidate. Model cost metadata in local probes is placeholder data and is not billing evidence.

The retained dev credentials and one-hour application grants expire independently. A future manual smoke must provision fresh authorized read credentials through the private flow, refresh the bindings through Alchemy, and rerun only inside the retained dev scope.

## Specification and source provenance

The implementation was derived from these reviewed MyPlan documents:

1. [Finalized workspace prompt, revision 9](https://example.invalid/private-reference)
2. [Architecture paper, revision 4](https://example.invalid/private-reference)
3. [Overview paper, revision 3](https://example.invalid/private-reference)

The finalized prompt and verified package contracts govern implementation. Supporting product context is linked from [architecture.md](architecture.md), including the shared Cloudflare stack, MCP Gateway/Portals, prompt-injection research, rich documents/MCP Apps, the MyPlan panel, and the MyPlan/Styld handoff.

The quality and rule source is a clean checkout of [`grmkris/myapps`](https://github.com/grmkris/myapps) at commit `54259fdd5a2560d2595167d7ff0650826a039102`. The source inventory and hashes are in [`tools/myapps-source-inventory.json`](../tools/myapps-source-inventory.json); the adapted rule/fixture provenance is in [`tools/quality-provenance.json`](../tools/quality-provenance.json). No My Apps legacy findings baseline was copied.

The three generic Cloudflare skills retain their upstream bytes and Apache-2.0 licenses from [`cloudflare/skills`](https://github.com/cloudflare/skills) at commit `b052c32bab7dd493513260228a36c88294f343f1`. The `effect-4` skill is explicitly adapted from the My Apps checkout; the source repository has no root license declaration, so no invented upstream license is assigned. Full source hashes, licenses, and adaptation notes are in `.agents/skills/sources.json`.

The compatibility reports record pinned package versions, installed declarations and source hashes, official references, tested entrypoints, and evidence boundaries:

- [native stack compatibility](stack-compatibility.md)
- [MCP compatibility matrix](mcp-compatibility.md)
- [architecture and ownership](architecture.md)
- implementation record
- handoff and continuation commands

Important pinned components include Agents SDK `0.26.0`, Pi Durable/Pi AI `1.0.1`, Alchemy `2.0.0-beta.80`, Effect `4.0.0`, Drizzle `1.0.0-rc.5-ab785fc`, Better Auth/MCP `1.7.6`, MCP client `2.2.0`, AG-UI `1.0.1`, MCP Apps `2.0.3`, TanStack Start `1.168.58`, Bun `1.4.2`, and Turbo `2.10.12`.

## Questions for the review

Please review the code and the evidence as a skeptical architecture and security reviewer, then answer these questions:

1. Is the ownership split still sound: Pi for all conversation/execution/recovery state, Drizzle only for application metadata, and D1 only for Better Auth/grants?
2. Is the separate D1 auth store the right v1 decision given the Durable SQLite adapter incompatibility, or should the auth boundary be redesigned before more features are added?
3. Are the grant checks, audience/issuer/session checks, untrusted-content handling, MCP Apps opaque-frame boundary, and secret-handling rules sufficient for the resident-agent threat model?
4. Is the authenticated `/api/mcp/*` host the right first core while standalone inbound OAuth UI and `/mcp` hosting remain deferred?
5. Does the compatibility matrix correctly distinguish unit, local workerd, two-process reconstruction, real provider, browser, retained Cloudflare dev, and production evidence?
6. Which deferred feature should be next: lifecycle/restart proof, MCP subscriptions/completion/elicitation, Portals, inbound OAuth UI, or production-readiness work?
7. What acceptance criteria should be required before production promotion, especially for remote eviction, in-flight alarms, cancellation, rate/cost limits, credential rotation, and rollback?
8. Are the My Apps quality rules, no-baseline policy, skill provenance, documentation checks, and CI gates appropriately scoped for the next implementation phase?
9. Identify any code path, evidence statement, dependency pin, or security boundary that should be changed before another agent starts work.
10. Give a short ordered list of the highest-value follow-up tasks, with the test or receipt that would prove each one.

## Suggested review path

Start with AGENTS.md, [architecture.md](architecture.md), implementation.md, and handoff.md. Then inspect [stack-compatibility.md](stack-compatibility.md), [mcp-compatibility.md](mcp-compatibility.md), the evidence JSON files, and the implementation under `apps/runtime`, `apps/web`, `packages/contracts`, and `apps/web/alchemy.run.ts`.

For a local deterministic review, use `bun run check` (the completed run used `TURBO_FORCE=true heavy`). The retained dev smoke is `bun run smoke:dev`, which requires the private mode-600 dev settings and fresh authorized disposable credentials. Do not copy those settings into a clean checkout or into review artifacts.

