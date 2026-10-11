import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import * as HttpApi from 'effect/http-api/HttpApi'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { InspectQuery } from '../inspect.ts'
import { API_ERRORS, ApiErrors } from './errors.ts'

/**
 * The agent's internal API: what reaches the owner's agent from the Worker on behalf of someone other than the owner's
 * browser. The Worker calls it on the agent's stub after its own check (a client's bearer token, a hook's route
 * token); the browser never can, because the Worker's edge forwards only `/api/*`. The web must not import this module.
 */

/** Every internal path starts with this; no owner path does (`OwnerApi` is under `/api`). */
export const INTERNAL_PREFIX = '/internal'

/**
 * The header the Worker's edge sets on every owner request it forwards. The agent refuses an internal path that
 * carries it, so nothing the owner's session reaches is an internal endpoint, whatever its path became on the way.
 */
export const FORWARDED_HEADER = 'x-goblin-forwarded'

/**
 * Whether the internal gate checks the account's plan before the endpoint runs (`InternalGate`): every internal
 * endpoint needs one except inspection, since reading your own agent never calls a model.
 */
export const RequiresPlan = Context.Reference<boolean>('goblin/api/RequiresPlan', { defaultValue: () => true })

/**
 * Admission to every internal endpoint, run by the agent before the handler: an owner forward is refused, then the
 * account's plan is checked unless the endpoint says otherwise (`RequiresPlan`). It never renews resident authority.
 * Its implementation lives in the runtime (`http/api/middleware.ts`); its error schema is every envelope.
 */
export class InternalGate extends HttpApiMiddleware.Service<InternalGate>()('goblin/api/InternalGate', {
  error: API_ERRORS,
}) {}

/** A user or assistant message; `author` names who wrote a user message when it was not the owner's browser. */
export const TranscriptMessage = Schema.Struct({
  role: Schema.Literals(['user', 'assistant']),
  text: Schema.String,
  author: Schema.optionalKey(Schema.String),
})
export type TranscriptMessage = typeof TranscriptMessage.Type

/** An inbound client's question, in main and labelled with the client's name. */
const AskInput = Schema.Struct({
  author: Schema.String,
  input: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** How long to wait for the answer before answering `running`. */
  waitMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 110_000 })),
})

/** The answer, or `running` with the operation id to wait again, or why the turn ended without one. */
export const AskResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal('done'), operationId: Schema.String, text: Schema.String }),
  Schema.Struct({ status: Schema.Literal('running'), operationId: Schema.String }),
  Schema.Struct({ status: Schema.Literal('unanswered'), operationId: Schema.String, reason: Schema.String }),
])
export type AskResult = typeof AskResult.Type

/** `?limit=`: how many of the newest messages, 1 to 50. */
const RecentQuery = {
  limit: Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 50 })),
}

/** A doorbell as myagent sent it: its body and the two headers that sign it. */
const Doorbell = Schema.Struct({ body: Schema.String, timestamp: Schema.String, signature: Schema.String })

/** The connection whose Events webhook a delivery came to (its id, as the hook's path names it). */
const ConnectionParam = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))

/** The headers an MCP Events webhook is signed and addressed with, as the sender sent them. */
const WebhookHeaders = {
  'x-mcp-subscription-id': Schema.String,
  'webhook-id': Schema.String,
  'webhook-timestamp': Schema.String,
  'webhook-signature': Schema.String,
}

/** What the agent answers the Events sender: a challenge's response (200), taken (204), ended (410) or later (503). */
export const EventWebhookResult = Schema.Struct({
  status: Schema.Literals([200, 204, 410, 503]),
  response: Schema.optionalKey(Schema.String),
})
export type EventWebhookResult = typeof EventWebhookResult.Type

/**
 * What reaches the agent besides the owner. Paths are relative to the API's `/internal` prefix; every endpoint can
 * also answer the gate's failures, and `error` names the ones the endpoint itself produces.
 *
 * - `ask`: `POST /internal/ask`, an inbound MCP client's question (needs current resident authority, never renews it).
 * - `recent`: `GET /internal/recent?limit=`, the newest messages of main.
 * - `doorbell`: `POST /internal/doorbell`, myagent's doorbell (channel/doorbell.ts), checked against its signature.
 * - `mcpEvents`: `POST /internal/mcp-events/:connectionId`, one connection's MCP Events webhook: its bytes and the
 *   headers that sign it.
 * - `inspect`: `POST /internal/inspect` with `{ query }`, /mcp's read-only inspection (ADR 0024). It answers the result
 *   of the query's kind (`InspectResult[kind]` in `../inspect.ts`), which the caller decodes; it needs no plan.
 */
export class InboundGroup extends HttpApiGroup.make('inbound').add(
  HttpApiEndpoint.post('ask', '/ask', {
    payload: AskInput,
    success: AskResult,
    error: [ApiErrors.conflict, ApiErrors.budgetExhausted],
  }),
  HttpApiEndpoint.get('recent', '/recent', { query: RecentQuery, success: Schema.Array(TranscriptMessage) }),
  HttpApiEndpoint.post('doorbell', '/doorbell', {
    payload: Doorbell,
    success: HttpApiSchema.NoContent,
    error: [ApiErrors.forbidden],
  }),
  HttpApiEndpoint.post('mcpEvents', '/mcp-events/:connectionId', {
    params: { connectionId: ConnectionParam },
    headers: WebhookHeaders,
    payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    success: EventWebhookResult,
    error: [ApiErrors.invalidInput],
  }),
  HttpApiEndpoint.post('inspect', '/inspect', {
    payload: Schema.Struct({ query: InspectQuery }),
    success: Schema.Unknown,
    error: [ApiErrors.notFound, ApiErrors.invalidInput],
  }).annotate(RequiresPlan, false),
) {}

/** The agent's internal API, served by the agent beside `OwnerApi` and called only by the Worker. */
export class InternalApi extends HttpApi.make('goblin-internal')
  .add(InboundGroup)
  .prefix(INTERNAL_PREFIX)
  .middleware(InternalGate) {}
