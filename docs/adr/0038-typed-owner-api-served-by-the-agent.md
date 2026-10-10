# ADR 0038: Typed owner API served by the agent

Accepted 2026-10-09 with the owner (the debuggability plan: an Effect-native runtime, one typed API and visible
conversation flows). Builds on ADR 0004 (an agent per user), ADR 0015 (plans, with its 2026-10-10 amendment) and
ADR 0037 (failure references). Follows myapps ADR 0013 (UI data), with the differences listed below.

Until now the Worker served the owner's `/api/*` from hand-written route tables, decoded request bodies with its own
local schemas, and called the user's agent through 71 hand-written Durable Object RPC methods, each starting with the
agent's `#owner` check (plan, then resident renewal). Workers RPC drops error classes, so every method returned a
homemade `RpcResult` (`{ ok, value | error }`) that the Worker unwrapped and mapped to a status. The web called those
routes with an untyped `request()` helper. One change meant editing the route table, the RPC method, its interface and
the web's call, and nothing checked that they agreed.

## One contract

The owner's API is one Effect HttpApi contract in `packages/contracts/src/api`, which imports `effect` only:

- **`OwnerApi`** (`owner.ts`): every owner endpoint under `/api`, one group per area in its own file: `conversations`,
  `topics`, `personas`, `organize`, `home`, `mcp`, `resident`, `agent`, `memory`, `routines`, `apps`, `agentApps`
  and `inspect`. Every endpoint passes the `OwnerGate` middleware. Paths, methods and success statuses are the ones
  the hand-written routes had, so URLs, smoke scripts and fixtures did not change.
- **`AccountApi`** (`account.ts`): what the Worker answers without waking the agent: `billing`, `clients` (inbound MCP
  clients) and `clientErrors` (browser crash reports).
- **`errors.ts`**: the runtime's failure vocabulary (`AppError`: `NotFound`, `Conflict`, `BudgetExhausted`, …), its
  HTTP statuses and its error envelope. The runtime re-exports it from `http/errors.ts`.

The request bodies the Worker declared locally, and the results it passed through untyped (a message receipt, a
started thread, Stop's `{ stopped }`, grants, the billing bodies), are contract schemas now.

## The error envelope

Every failure answers `{ error: { code, message, recovery?, …safe fields, ref? } }`, as myapps does:

- `code` is the `AppError` tag in lower_snake_case (`NotFound` is `not_found`); the typed client decodes it back into
  the tagged class. One envelope per status (`ApiErrors`), so a union picks the right one: `UpstreamMcp` answers 502,
  or 504 for a timeout.
- `message` and `recovery` are fixed copy (`ERROR_COPY`), never runtime text.
- The safe fields the UI uses are kept: `reason`, `what`, `serverId`, `name`, `state`, `subscribe`, `limit`,
  `resetsAt`, and `rpcCode` for an MCP server's JSON-RPC code (`code` is the envelope's own).
- `ref` is the request's reference (below). Every answer also carries it as `x-goblin-ref`, with `cache-control:
  no-store` and `x-content-type-options: nosniff`.

A request HttpApi cannot decode is answered as the hand-written routes answered it: a path parameter that does not
parse names nothing (404), a body, query or header that does not match is `invalid_input` (400), and so is a body that
is not JSON. A failure from stored data or from a value the agent built is the agent's fault: `Internal` (500),
reported with its stack locations, never its message (ADR 0037). Billing refusals keep their own codes in the same
shape (`BillingRefused`).

## Served inside the agent

**The Worker edge** (`http/api/edge.ts`, built once per isolate) keeps what must happen before an agent wakes:

- The account API is answered in the Worker (`http/api/account.ts`): billing for any signed-in account, clients for
  one with a plan, and crash reports without a session (a crash on the sign-in page is reported too).
- Every other `/api/*` request is admitted, then forwarded to the signed-in user's own agent:
  1. a write whose `Origin` names another site is refused;
  2. the session comes from the cookie alone (a request with an `Authorization` header is refused);
  3. every write needs the app's own `Origin` and `x-goblin-csrf: 1` (`http/csrf.ts`), which the web sends on every
     write;
  4. the plan is read fresh from auth D1 (402 without one);
  5. a body is capped at 64 KiB, except file bytes, which stream through to the agent's own limits;
  6. the request goes to `AGENTS.getByName(userId).fetch` with an allowlisted set of headers (`content-type`,
     `content-length`, `accept`, `last-event-id`, `x-goblin-request`, `x-goblin-operation`, `x-mcp-caller`) and the
     edge's reference in `x-goblin-ref`. Cookies and authorization never reach the agent.
- Each failed answer, the edge's own refusals and the agent's alike, is one content-free `http.failure` log line:
  route template, method, status, code, reference, the browser's request and operation ids, and the agent.

**The agent** (`PersonalAgent.onRequest`) serves the contract with `AgentHttp` (`http/api/server.ts`): the router is
`HttpRouter.toHttpEffect` over every group's handlers (`http/api/groups.ts`), built once inside the agent's own
runtime as a layer, never at module level. Handlers (`<area>/api.ts`) get the agent's services from context. What is
not JSON in and out is served through HttpApi's raw handlers (amended 2026-10-10; these were raw routes of the agent):

- `GET /api/conversations/:id/events` and `GET /api/workspace/events`, the server-sent event streams;
- `/api/files` and `/api/files/content`, the owner's file bytes;
- `GET /api/mcp/oauth/callback`, an outbound sign-in coming back, answered with a redirect to Connections (carrying
  `ref` when it failed).

Anything else is an envelope 404. The agent's internal API (`/internal`, amended 2026-10-10) is outside `/api`, so no
browser request reaches it; only the Worker calls it, `/mcp`'s inspection among it, for a client that holds
`goblin:inspect` (ADR 0024).

**The owner gate** (`OwnerGate`, `http/api/middleware.ts`) replaces `#owner`. Before the handler, and before HttpApi
decodes a body, it requires the plan through the agent's `Entitlements` (an active plan is kept for 60 seconds, ADR
0015) and renews resident authority, except on an endpoint annotated `RenewsResident: false`: only
`POST /api/agent/resident`, because a revocation must not renew first. The gate annotates the request's logs with
`goblin.rpc` (`<group>.<endpoint>`), `goblin.operation` and `ref`, and stamps the reference on every typed failure.

## Durable Object RPC that remains

One method remains (amended 2026-10-10): `deleteAgentData` (account deletion) erases the owner's files, closes the
runtime and destroys the object, and returns an encoded `RpcResult` (`http/rpc.ts`), because Workers RPC drops error
classes. The callers that are not the owner's browser (inbound `/mcp`'s ask, recent read and inspection, myagent's
Telegram doorbell, signed MCP Events) reach the agent through its internal API (`InternalApi`, `/internal`), which the
Worker calls on the stub's `fetch` with a typed client, behind `InternalGate`.

Deleted at the switch: the 71 owner methods on `PersonalAgent` and `AgentRpcMethods`, `#owner`, `organize/rpc.ts`,
the Worker's route tables and local body schemas, the route modules of routines, topics, personas, organize and home,
and the web's `request()` (`lib/boundary.ts`).

## Why inside the agent

- **One typed surface.** The contract decodes and encodes where the program runs. There is no second schema in the
  Worker and no envelope over RPC, and a new endpoint is one contract entry and one handler.
- **Services in context.** A handler is an Effect over the agent's own services, like every other program the agent
  runs, instead of one hand-written RPC method per call.
- **The Worker stays small.** It keeps identity, origin and CSRF, the fresh plan and the body cap, which must hold
  before any agent wakes, and the account endpoints, which need no agent.

## The web

`apps/web/src/lib/api.ts` builds the two typed clients with `HttpApiClient.make` over the query bridge
(`lib/query/api-query.ts`, a port of myapps' `@myapps/query` with its provenance in `lib/query/PROVENANCE.md`). Every
request sends a fresh `x-goblin-request` id, every write the CSRF header, and a write run with `withOperation` its
`x-goblin-operation`. Feature factories (`src/<feature>/queries.ts`), loaders and the stream stores follow the
data-layer rule in apps/web/AGENTS.md.

## Alignment with myapps ADR 0013

The same: an HttpApi contract per app and its typed client; the `{ error: { code, message, recovery? } }` envelope
with lower_snake_case codes that the client turns back into tags; one `queryOptions`/`mutationOptions` factory per
endpoint, grouped per feature; loaders that only prime the cache; mutations that invalidate what they change; socket
and SSE events that only invalidate; no Effect RPC for request and response, and no Effect Atom. The myapps
data-invariant lint rules (`no-transport-outside-client`, `no-network-in-effect`, `no-loader-data`) are ported to the
web (lint and quality says where they apply).

The differences:

- **Served by the user's own Durable Object**, not by the Worker. In myapps the app's Worker serves its API; here
  the owner's data lives in their agent, so the contract is served there and the Worker only admits and forwards.
- **No signed-in layout.** Owner pages render inside `OwnerGate`, which signs a visitor in on the page itself. A
  loader runs ahead of that gate, so it primes and decides nothing (`lib/prime.ts` `primeOwnerRead`).
- **References.** The envelope adds `ref`, and the web quotes it with every failure (ADR 0037).
- **Outside the API.** Better Auth's routes, `/health`, `/mcp` and the hooks keep their own protocols. No OpenAPI document is published yet.

## Consequences

- Every owner write needs the CSRF header; before, only some areas did. An endpoint's failure body is the envelope,
  no longer `{ error: Tag, …fields }`; since 2026-10-10 the hooks and the Worker's fallback answer the envelope too.
- An unknown `/api` path is an envelope 404, and the owner gate admits a request before its body is decoded.
- Each owner request is one `fetch` from the Worker to the agent, as an RPC call was before. Workers RPC's lost error
  classes no longer matter for the owner.
- Tests: each group's handlers are served in memory with only the services that area needs
  (`served([Group], handlers)` over `AgentHttp.serve`, `test/http/api/fixture.ts`), and the edge's admission is unit-tested
  (`test/http/api/edge.test.ts`). Integration probes call the agent through the typed client over its stub's `fetch`
  (`test/integration/owner-api.ts`), standing where the Worker's admission stood. The web's tests serve the real
  contract in memory (`fakeHttpApi`).
