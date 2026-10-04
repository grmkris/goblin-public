# Purrable MCP compatibility

Review date: 2026-10-04. This is an evidence ledger, not a promise of support. A green unit test is not a deployed-provider result. Server identity in the SDK is diagnostic; the configured endpoint and authenticated issuer/resource are the trust boundary.

Client baseline: `@modelcontextprotocol/client` 2.2.0. MCP Apps baseline: `@modelcontextprotocol/ext-apps` 2.0.3. Better Auth baseline: `better-auth` 1.7.6 + `@better-auth/mcp` 1.7.6 + `jwt()` plugin. Public MCP documentation reviewed by the assignment is revision 2026-07-28; the negotiated revision is recorded per run.

| Feature | Spec revision | Client / server SDK | Server identity / environment | Negotiated capability | Implementation | Test / evidence | Auth boundary | Gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Streamable HTTP + initialize | 2026-07-28 / legacy fallback | client 2.2.0; server varies | in-memory fixture / unit | modern auto tested; legacy fallback delegated to SDK | implemented | `apps/runtime/test/mcp/connection.test.ts` / unit | inbound signed bearer requires enabled client + live session; owner cookie stays distinct | fixture does not prove provider deployment |
| `server/discover` and version negotiation | 2026-07-28 | client 2.2.0 | fixture / unit | `auto`; HTTP timeout fails closed; no silent downgrade | implemented | SDK `getProtocolEra` and `getNegotiatedProtocolVersion` assertions | outbound audience-bound token source | dev endpoints negotiate modern 2026-07-28; production not tested |
| `tools/list` pagination + `_meta` | 2026-07-28 | client 2.2.0; server varies | fixture / unit | `tools` advertised | implemented | list max pages 64; metadata retained | exact tool grant required for calls | no cursor replay claim on reconnect |
| `tools/call` + schemas/structured content | 2026-07-28 | client 2.2.0 | fixture / unit | `tools` advertised | implemented | result `isError` remains logical result; RPC errors mapped | issuer/subject/client/resource/server/tool grant + generation | CF Worker JSON Schema validator explicitly selected; dialect gaps documented upstream |
| resources list/read/templates | 2026-07-28 | client 2.2.0; server varies | fixture / unit | `resources` advertised | implemented | capability-gated and paginated | exact resource URI grant | subscriptions deferred |
| prompts list/get | 2026-07-28 | client 2.2.0; server varies | fixture / unit | `prompts` advertised | implemented | capability-gated and paginated | exact prompt grant | completion deferred |
| rich content / embedded resources | 2026-07-28 | client 2.2.0; server varies | fixture / unit | result content preserved | implemented | structured result, native image, rich-tagging and redaction assertions | content is untrusted data | MIME rendering is host-specific |
| progress + cancellation + timeout | 2026-07-28 | client 2.2.0 | official SDK fixture / unit | progress callback / AbortSignal | implemented | SDK RequestOptions forwarded; provider progress/cancellation not yet exercised | grant checked before request | provider cancellation semantics vary |
| reconnect / refreshed state | 2026-07-28 | client 2.2.0 | official SDK fixture / unit | fresh handshake + authoritative discovery | implemented | manager `reconnect` tests | refreshed auth/grants | no restart/eviction claim |
| resource subscriptions | 2026-07-28 | client 2.2.0 | MyPlan / MyBrowser unknown | not advertised in current baseline | deferred | no real evidence | same grant boundary when added | no durable replay log |
| completion | 2026-07-28 | client 2.2.0 | MyPlan / MyBrowser unknown | unknown | deferred | no real evidence | same auth/grant boundary | add only after provider advertises |
| `input_required` / elicitation | 2026-07-28 | client 2.2.0 | MyPlan / MyBrowser unknown | unknown | deferred | no real evidence | human approval must be explicit | needs durable Pi interaction state |
| Tasks / Skills / draft Events | 2026-07-28 | client 2.2.0 | unknown | not advertised | deferred | no real evidence | same trust boundary | explicitly out of first implementation |
| MCP Apps `ui://` resource host | ext-apps 2.0.3 / 2026-07-28 | client 2.2.0; ext-apps 2.0.3 | MyPlan dev-new / retained dev deployment | tool `_meta.ui.resourceUri` | implemented | 2026-10-04 00:52:22Z Chromium receipt: connect 200, tool 200, resource 200, nested opaque frames, read-only `panel_browse` 200 | owner session + originating server + exact tool/resource grants; app caller header is checked | host-only 16 MiB HTML bound; no production claim |
| MyPlan real endpoint | 2026-07-28 | client 2.2.0; server 0.2.0 | `https://dev-new.myplan.lol/mcp` / dev deployment | modern; tools/resources | authenticated discovery, resident call, and App interaction | 2026-10-04 discovery + Pi tool-result + browser Apps receipts below | PKCE + read on one disposable workspace; openid scope; exact local grants | no production receipt |
| MyBrowser real endpoint | 2026-07-28 | client 2.2.0; server 0.1.0 | `https://dev.mytab.lol/mcp` / dev deployment | modern; tools | authenticated discovery + harmless read | 2026-10-04T01:10:45Z `browser_backends` 200; receipt | PKCE + read, 3600s grant TTL, no providers/personal browser | no browser-session/provider-spending or production receipt |

## Provider smoke receipt template

Record UTC time, Purrable SHA, lockfile hash, environment, endpoint, HTTP status, negotiated era/version, serverInfo, capabilities, authenticated subject/client/scopes (never token), operation IDs, and readback. Mark each row `unit`, `local workerd`, `dev deployment`, `staging`, or `production`. A local fixture, a second read from one live object, or a browser screenshot cannot establish provider deployment/restart/production support.

## Current local evidence

`apps/runtime/test/mcp` passes 12 Vitest tests (2026-10-04, unit). The official MCP server/client fixture establishes modern negotiation, unknown metadata and structured result preservation, app visibility filtering, granted resource reads, exact grant denial, fresh reconnect, principal expiry rejection, and oversize discovery rejection. Apps tests separately prove HTML/MIME/URI/grant/owner limits, while ordinary reads retain their smaller bound. The Pi projection test establishes native text/image support, explicit rich-data tagging, origin attribution and secret-key redaction. Auth tests exercise claims, grant generation/scope and bootstrap policy.

Progress callbacks and cancellation signals are forwarded to the official SDK, but no provider progress/cancellation receipt is recorded. Prompt discovery/get and resource-template discovery are implemented but do not yet have authenticated real-server acceptance evidence. Ordinary tool, prompt, resource, and discovery results are capped at 1 MiB before host/model projection; the owner-only Apps path accepts only exact `ui://` HTML resources up to 16 MiB. Pagination is limited to 64 pages. Individual signed-JWT revocation is not claimed: the active client, authoritative session and application grant generation are checked. Session-free and sender-constrained inbound JWTs fail closed in this initial boundary.

Authenticated dev discovery is recorded below. Purrable deployed auth/schema behavior and the resident Pi-to-MyPlan
tool call are separate acceptance receipts; the resident call is dev evidence, not a production support claim.

## Authorized dev endpoint smoke (2026-10-04)

At 2026-10-04T00:21:47Z (MyPlan) and 00:21:49Z (MyBrowser), the bounded read-only smoke used fresh public OAuth clients and PKCE flows against both disposable dev endpoints. It recorded only status, negotiated metadata and names; access/refresh tokens, cookies and passwords remain in mode-600 `.local/dev.env` bindings and are not in this document.

| Endpoint | Auth flow | HTTP receipts | Negotiated revision | Server | Advertised capabilities | Safe discovery result |
| --- | --- | --- | --- | --- | --- | --- |
| `https://dev-new.myplan.lol/mcp` | owner password session → DCR → PKCE consent with `read`, `reach=workspaces`, one configured smoke workspace, no extra scopes | metadata 200; sign-in 200; DCR 201; authorize 302; consent 200; token 200 | modern / `2026-07-28` | `myplan` `0.2.0` | `tools`, `resources` | 22 tool names; 1 resource; 0 prompts; app resources on three UI tools |
| `https://dev.mytab.lol/mcp` | owner password session → DCR → PKCE consent with read grant, 3600-second TTL, no providers, no personal browser | metadata 200; sign-in 200; DCR 201; authorize 302; grant 200; consent 200; token 200 | modern / `2026-07-28` | `mybrowser` `0.1.0` | `tools` | 34 tool names; 0 resources; 0 prompts; no app UI metadata |

These are authenticated **dev deployment discovery receipts**, not production support claims. Discovery lists names supplied by the provider even when the approved read grant prevents write or provider-spending calls; no tool call, browser session, message, purchase, or provider action was made. The private binding records the issued subject, issuer, resource, scopes and expiry for each run-owned token so the Purrable runtime can pin its outbound audience and server identity without serializing token bytes into snapshots or model context. The clients and grants are disposable and should be revoked or allowed to expire after the retained smoke window.

## Resident Pi dev acceptance

At 2026-10-04 00:49 UTC, the retained Cloudflare dev Worker accepted an owner submission through PiHarness, used the
Railway LiteLLM model route, and executed one exact-grant `mcp_call` for MyPlan `myplan_open` with `{}`. The wait receipt
returned `done`; the durable snapshot contained an assistant tool call, a `pi.tool-result` with `toolName: mcp_call` and
`isError: false`, the remote tool name, and the `PURRABLE_MCP_OK` completion marker. The receipt records only statuses and
booleans; no remote note content, token, cookie, or password is persisted in this document. This proves the selected
dev vertical slice and its authorization boundary, not exactly-once external effects or production behavior.

## Inbound OAuth UI gap

Better Auth `mcp()` and `jwt()` provide the configured authorization-server endpoints, and the application's signed-bearer boundary checks issuer/resource, client state and authoritative session state. Purrable currently has no product login or consent pages at the configured `/login` and `/consent` locations and no standalone MCP protocol server at `/mcp`; its web/model host uses the authenticated `/api/mcp/*` gateway. A standalone external OAuth connector flow is not accepted v1 evidence. Owner-cookie login and explicit capability grants are the verified application path; inbound connector UI and protocol hosting require separate implementation and acceptance.

The ignored mode-600 provisioning script is retained at `.local/mcp-provision.ts`. Its command is `bun --env-file ~/.config/myapps/dev.env .local/mcp-provision.ts`. It creates new disposable read clients on each run, keeps tokens private, and prints only safe status/discovery receipts. Use it only for the explicitly authorized dev endpoints and smoke accounts; no production credential or endpoint fallback is implemented.

The first smoke's two client grants were revoked by exact client ID before replacement (`MyPlan` and `MyBrowser`
both returned 200). A later MyBrowser access token expired before its one-hour application grant; token lifetime and
grant lifetime are distinct. Fresh disposable read clients were provisioned and the retained Worker secret bindings
updated through Alchemy at 2026-10-04 01:09:03 UTC. Remaining disposable grants expire; no production grant was used.

The repository's `bun run smoke:dev` then passed at 2026-10-04 01:10:45 UTC:
sanitized receipt. MyPlan `myplan_open` and MyBrowser `browser_backends` returned 200;
discovery negotiated `2026-07-28` with 22 and 35 tools respectively. The resident Pi submission produced a matching
assistant `mcp_call`, its correlated successful committed tool result, and the exact assistant completion marker.
This newer catalog does not overwrite the earlier historical discovery counts. Future runs need current outbound
tokens as well as live owner credentials/grants; expired tokens fail closed. Refresh through the private provisioning
flow above, redeploy the dev bindings, and rerun the manual smoke only within the authorized dev scope.
