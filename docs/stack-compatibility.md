# Native stack compatibility

Reviewed 2026-10-04 against the pinned packages and Cloudflare's [PiHarness documentation](https://developers.cloudflare.com/agents/harnesses/pi/index.md), updated 2026-10-02.

| Component | Version | Evidence | Boundary / gap |
| --- | --- | --- | --- |
| Agents SDK | `0.26.0` | Native `PersonalAgent extends Agent`; `this.lifecycle.use(harness)` boots in Alchemy `Test.make({ dev: true })` local workerd. | PiHarness is beta. |
| PiHarness | `agents/harness/pi` from Agents `0.26.0` | Factory receives `{ storage, context }`; `Harness.open` and `PiHarness.submit/wait/messages/sessions.list` pass. | Session event streams provide snapshot plus committed batches, without cursor replay. |
| Pi Durable | `1.0.1` | Fixture model completes a real input; receipt deduplication, transcript readback, raw Pi disposal/reopen, and fresh workerd reconstruction pass. | Experimental package; eviction proof is outside local workerd evidence. |
| Pi AI | `1.0.1` | Deterministic provider and OpenAI-compatible provider both satisfy the model seam. | Deployed LiteLLM streaming/tool compatibility is a separate dev gate. |
| Alchemy | `2.0.0-beta.80` | `alchemy/Test/Vitest` with `Cloudflare.providers()`, `Alchemy.localState()`, `dev:true` serves local workerd. | Bundle must not import Alchemy deployment modules. Local workerd accepts compatibility dates through `2026-09-25`. |
| Effect | `4.0.0` | Required by Alchemy test runtime and app composition. | No claim that Effect changes Pi state ownership. |
| Vitest | `5.0.1` | Two integration tests pass under the Alchemy Vitest harness; a second explicit process runs three including reconstruction. | Harness is local workerd only. |
| Drizzle | `1.0.0-rc.5-ab785fc` | Migration adds `app_metadata`; the runtime `AppMetadata` Effect service performs typed get/upsert readback, while the integration proof leaves every observed vendor schema unchanged. | Drizzle is limited to `app_*`; never introspect or migrate vendor tables. |

The bounded host provider probes used the verified `gemini-3.8-flash` alias. CLIProxy returned `stop` with the expected streamed marker and `toolUse` with the expected tool name and argument. Host-to-Railway LiteLLM independently passed both checks. The retained Cloudflare dev acceptance then executed one exact-grant, read-only MyPlan `myplan_open` call through Pi and read back its committed tool result. The portable Pi API permits `toolChoice: 'auto' | 'none'`; forcing an unsupported object caused LiteLLM to reject the initial probe, and the corrected `auto` probe passed. These are host and retained-dev checks; production reachability and eviction remain separate evidence classes.

The reusable manual command is `bun --env-file .local/dev.env apps/runtime/test/provider-probe.ts`; it reads only the dedicated `PURRABLE_MODEL_*` environment, performs two requests with at most 150 output tokens each, prints redacted booleans/statuses, and does not execute tools. Model cost metadata is currently zero-rate placeholders, so Pi-derived dollar totals are not billing evidence. The dedicated LiteLLM key budget remains the financial authority.

Application migrations run through the pinned Drizzle Durable SQLite migrator, using bundled SQL only. Its `__drizzle_migrations` table is application-owned migration bookkeeping, an explicit exception to `app_*`; it never adopts Pi or Agents tables. `AppMetadata.layer(storage)` is the application storage service. It exposes typed `get`/`set` effects over Drizzle, with short synchronous SQLite operations and no model/network work inside transactions.

The observed vendor ownership set includes Agents tables outside the `pi_` prefix: `cf_agent_tool_runs`, `cf_agents_facet_runs`, `cf_agents_fibers`, `cf_agents_jobs`, `cf_agents_mcp_servers`, `cf_agents_runs`, `cf_agents_state`, `cf_agents_task_runs`, `cf_agents_task_steps`, `cf_agents_workflows`, plus `pi_conversations`, `pi_document_revisions`, `pi_documents`, `pi_durable_metadata`, `pi_durable_schema`, `pi_entries`, `pi_record_ids`, `pi_submissions`, and `pi_tasks`. Source inspection also requires protecting `cf_agents_sub_agents`, `cf_agents_streams`, `cf_agents_stream_blocks`, and `_cf_*` platform tables when those capabilities are enabled.

The compatibility spike was retained in `apps/runtime/test/integration/native.test.ts`, `worker.ts`, `model.ts`, and
`stack.ts`. The default integration suite proves actual PersonalAgent initialization, additive application migrations,
native Pi submission, duplicate receipts, transcript readback, and public `PiHarness.dispose()`/`pi()` reopening.
For the separate reconstruction proof, run these two processes sequentially from the repository root:

```sh
PURRABLE_NATIVE_LIFECYCLE_PHASE=write heavy bun run --cwd apps/runtime test:integration
PURRABLE_NATIVE_LIFECYCLE_PHASE=read heavy bun run --cwd apps/runtime test:integration
```

Both passed on 2026-10-04 (two tests in the first process, three in the second). The second process has a different
test PID and native Agent instance, reads the identical persisted transcript, and preserves receipt deduplication.
Intermediate fixtures stay ignored under `apps/runtime/.alchemy`; the
sanitized reconstruction receipt is retained. This establishes local SQLite
reconstruction through public APIs; remote eviction, in-flight alarm recovery and production lifecycle remain unproven.

Alchemy's Vitest/workerd harness is selected because its pinned integration starts the native Agent binding, preserves
SQLite across two explicit processes, and uses the same infrastructure declaration API as deployment. Cloudflare's
separate Workers Vitest pool has no accepted pinned-stack receipt here; it is not installed as a competing runner.
The built artifact is independently accepted through the real dev deployment and browser/MCP smoke, rather than
assuming that source-harness success proves the production bundle. Alarm/model-call limits remain delegated to the
beta harness and are not load-tested; cancellation can wait for an uncooperative tool. Conversation deletion is not
implemented in this core.

Installed source evidence (SHA-256): Agents `dist/harness/pi/index.js` is `95628ff43a5d9ab712559dc133b2f829d83cfc310bc3b8e0d3b72ccee2918556`; its declarations are `7775708f84d2f6cfa08ba70989207d2cd266bf21b237c9f15cef48afe1d73339`. Pi Durable `dist/storage/sqlite/migrations.js` is `2e3c0134615e89c060c19c7a62f4485025c78516ba26b0662310a48fe8776e68`, and its public `dist/index.js` is `3b4fbadce8cd28867621ef832b1597d02fae7a4b6b0abc394a9a241798b89d34`. Exact package dependencies and lockfile are retained in the isolated spike. The repository lockfile pins the shipped composition independently.

The resident Pi registry rebuilds the static `mcp_list`/`mcp_call` tools on each native Agent construction. No network call occurs during lifecycle startup. Authenticated submission stores only Schema-validated owner/session metadata in `app_metadata`; each MCP tool execution rereads it, verifies the active D1 owner session, acquires its MCP connection, and checks live capability grants. MCP credentials stay in the manager closure. `mcp_call` is replay-unsafe; acceptance and durable receipts do not imply exactly-once external effects.

## Pinned API and source inventory

Reviewed installed declarations and the implemented call sites on 2026-10-04. Official references below are the API sources; local compile/build or host acceptance does not imply remote lifecycle support.

| Package | Pin | Entry point / verified use | Official reference | Evidence boundary |
| --- | --- | --- | --- | --- |
| `alchemy` | `2.0.0-beta.80` | `alchemy/Cloudflare`: `Website.Vite`, native `DurableObject`, D1 migrations; `alchemy/Test/Vitest` | [Alchemy](https://alchemy.run/) | Local workerd, plan and actual dev deploy |
| `agents` | `0.26.0` | `agents/harness/pi`: `PiHarness`, lifecycle registration, receipt/wait | [PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/) | Beta; reconstruction distinct from remote eviction |
| `@earendil-works/pi-durable` | `1.0.1` | `Harness.open`, `createRegistry`, `defineExtension`, `defineTool` | [Cloudflare Pi integration](https://developers.cloudflare.com/agents/harnesses/pi/) | Experimental; Pi owns state |
| `@earendil-works/pi-ai` | `1.0.1` | `/models`, `/api/openai-completions`: custom streaming provider | [Pi model integration](https://developers.cloudflare.com/agents/harnesses/pi/) | Host streaming/tool probe and dev model completion |
| `effect` | `4.0.0` | `Context.Service`, `Layer.succeed`, `Schema`, `Config`, typed errors | [Effect](https://effect.website/docs/) | App metadata service and complete diagnostics scope |
| `drizzle-orm` | `1.0.0-rc.5-ab785fc` | `/durable-sqlite` and `/durable-sqlite/migrator` | [Drizzle Durable SQLite](https://orm.drizzle.team/docs/connect-cloudflare-do) | Application-owned tables only |
| `better-auth` | `1.7.6` | `better-auth`, `/plugins` jwt; `@better-auth/mcp` mcp `1.7.6`; oauth-provider override `1.7.6` | [Better Auth MCP](https://www.better-auth.com/docs/plugins/mcp) | D1 owner-session boundary; inbound connector UI deferred |
| `@modelcontextprotocol/client` | `2.2.0` | Streamable HTTP, capabilities, `validators/cf-worker` | [MCP specification](https://modelcontextprotocol.io/specification/latest) | Negotiated dev versions and feature ledger in MCP report |
| `@ag-ui/core` | `1.0.1` | `EventType`, message/state snapshot projection | [AG-UI](https://docs.ag-ui.com/) | Pi remains authoritative; browser projection/reconnect tested |
| `@modelcontextprotocol/ext-apps` | `2.0.3` | `/app-bridge`: `AppBridge`, `PostMessageTransport` | [MCP Apps](https://modelcontextprotocol.io/docs/extensions/apps) | Sandbox render and permitted interaction are separate gates |
| `@tanstack/react-start` | `1.168.58` | `/plugin/vite`, server/client entries, file routes | [TanStack Start](https://tanstack.com/start/latest/docs/framework/react/overview) | Client and SSR builds; deployed browser render |

The quality stack is pinned separately in package manifests and [rule provenance](../tools/quality-provenance.json): TypeScript `7.0.2`, Oxlint `1.81.0`, Oxfmt `0.66.0`, `oxlint-tsgolint` `7.0.2003`, `@effect/tsgo` `0.47.2`, Knip `6.39.0`, jscpd `5.4.0`, and Bun `1.4.2`. `cn` is `0.3.2` so the shadcn linter uses the same class grammar as the UI. Native Agents ships its own MCP dependencies; Purrable's portable connection manager explicitly uses client `2.2.0` and does not claim acceptance of every SDK-native MCP extension.
