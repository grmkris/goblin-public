import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import {
  AddServer,
  AppGrantChange,
  ApprovalDecision,
  ApprovalView,
  AskFirstChange,
  CatalogResults,
  ConnectStart,
  EventStream,
  RenameConnection,
  Grant,
  GrantChange,
  McpResourceResult,
  McpToolResult,
  RegistryChange,
  RegistryView,
  ResourceRead,
  ServerSuggestion,
  ServerView,
  SkillsChange,
  SkillsSetting,
  StepUp,
  ToolCall,
  ToolView,
  SpendingChange,
  SpendingView,
  UrlRequestAnswer,
  UrlRequestView,
  WalletStatus,
} from '../mcp.ts'
import { ApiErrors } from './errors.ts'
import { RenewsResident } from './resident.ts'

/** A connection's id in a path; anything else names no connection (404). */
const ConnectionParam = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))
/**
 * A held call's or URL request's id in a path (`mcp:<session>:<call>`, `mcp-url:<session>:<call>`): anything else names
 * none (404).
 */
const ApprovalParam = Schema.String.check(Schema.isPattern(/^[\w:-]{1,256}$/u))
/**
 * Who calls through the owner's session: an App the owner opened sends `x-mcp-caller: app`, which narrows the call to
 * what the App may use; any other value, or none, is the owner by hand.
 */
const Caller = { 'x-mcp-caller': Schema.optional(Schema.String) }

/** What a remote call can answer besides its result: the server failed, timed out or wants sign-in again. */
const REMOTE = [ApiErrors.upstream, ApiErrors.upstreamTimeout, ApiErrors.conflict, ApiErrors.forbidden] as const

/**
 * The owner's MCP servers (ADRs 0003, 0005, 0006, 0008, 0028): the offered servers and the catalog to add more from,
 * signing in, exact grants, held calls, and calling a server by hand or from an App. Paths are relative to the API's
 * `/api` prefix. Every owner endpoint can also answer owner admission's failures; `error` names the ones the endpoint
 * itself produces. Remote results are the server's, untrusted, and answered whole.
 *
 * `oauthCallback`: `GET /api/mcp/oauth/callback`, an outbound sign-in coming back, answered with a redirect to
 * Connections (with `?error=` and the request's `ref` when it failed). It does not renew resident authority.
 */
export class McpGroup extends HttpApiGroup.make('mcp').add(
  HttpApiEndpoint.get('servers', '/mcp/servers', { success: Schema.Array(ServerView) }),
  HttpApiEndpoint.post('addServer', '/mcp/servers', {
    payload: AddServer,
    success: ServerView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.invalidInput, ApiErrors.conflict, ApiErrors.internal],
  }),
  HttpApiEndpoint.patch('renameConnection', '/mcp/:id', {
    params: { id: ConnectionParam },
    payload: RenameConnection,
    success: ServerView,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.get('suggested', '/mcp/suggested', { success: Schema.Array(ServerSuggestion) }),
  HttpApiEndpoint.get('catalog', '/mcp/catalog', {
    query: { q: Schema.optional(Schema.String) },
    success: CatalogResults,
    error: ApiErrors.invalidInput,
  }),
  HttpApiEndpoint.get('registries', '/mcp/registries', { success: Schema.Array(RegistryView) }),
  HttpApiEndpoint.post('addRegistry', '/mcp/registries', {
    payload: RegistryChange,
    success: Schema.Array(RegistryView).pipe(HttpApiSchema.status(201)),
    error: ApiErrors.invalidInput,
  }),
  HttpApiEndpoint.post('removeRegistry', '/mcp/registries/remove', {
    payload: RegistryChange,
    success: Schema.Array(RegistryView),
    error: ApiErrors.invalidInput,
  }),
  HttpApiEndpoint.get('grants', '/mcp/grants', { success: Schema.Array(Grant) }),
  HttpApiEndpoint.put('setToolGrant', '/mcp/grants', {
    payload: GrantChange,
    success: Schema.Array(Grant),
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  HttpApiEndpoint.put('setAskFirst', '/mcp/ask-first', {
    payload: AskFirstChange,
    success: Schema.Array(Grant),
    error: ApiErrors.forbidden,
  }),
  HttpApiEndpoint.put('setSkills', '/mcp/skills', {
    payload: SkillsChange,
    success: SkillsSetting,
    error: [ApiErrors.notFound, ApiErrors.invalidInput, ...REMOTE],
  }),
  HttpApiEndpoint.put('setAppGrant', '/mcp/app-grants', {
    payload: AppGrantChange,
    success: Schema.Array(Grant),
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  HttpApiEndpoint.get('approval', '/mcp/approvals/:id', {
    params: { id: ApprovalParam },
    success: ApprovalView,
    error: ApiErrors.notFound,
  }),
  HttpApiEndpoint.post('decideApproval', '/mcp/approvals/:id', {
    params: { id: ApprovalParam },
    payload: ApprovalDecision,
    success: ApprovalView,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  /** `GET /api/mcp/url-requests/:id`: a URL request the model's call met (ADR 0042), as its owner sees it. */
  HttpApiEndpoint.get('urlRequest', '/mcp/url-requests/:id', {
    params: { id: ApprovalParam },
    success: UrlRequestView,
    error: ApiErrors.notFound,
  }),
  /**
   * `POST /api/mcp/url-requests/:id`: the owner finished the server's step (`accept`) or cancels it (`decline`); the call
   * is retried once with that answer, and the server's result goes back to the turn that asked.
   */
  HttpApiEndpoint.post('answerUrlRequest', '/mcp/url-requests/:id', {
    params: { id: ApprovalParam },
    payload: UrlRequestAnswer,
    success: UrlRequestView,
    error: [ApiErrors.notFound, ApiErrors.conflict],
  }),
  HttpApiEndpoint.get('tools', '/mcp/:id/tools', {
    params: { id: ConnectionParam },
    query: { refresh: Schema.optional(Schema.String) },
    success: Schema.Array(ToolView),
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  HttpApiEndpoint.get('events', '/mcp/:id/events', {
    params: { id: ConnectionParam },
    success: Schema.Array(EventStream),
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  /** `POST /api/mcp/:id/events/dismiss`: the owner wants nothing from this connection's events (ADR 0041). */
  HttpApiEndpoint.post('dismissEvents', '/mcp/:id/events/dismiss', {
    params: { id: ConnectionParam },
    success: Schema.Null,
    error: [ApiErrors.notFound],
  }),
  HttpApiEndpoint.post('connect', '/mcp/:id/connect', {
    params: { id: ConnectionParam },
    success: ConnectStart,
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  /**
   * `POST /api/mcp/:id/recommended`: a first-class server's recommended grants (ADR 0043), applied in one go: its free
   * tools run when needed, its paid ones ask first. A tool the server does not list now is skipped.
   */
  HttpApiEndpoint.post('allowRecommended', '/mcp/:id/recommended', {
    params: { id: ConnectionParam },
    success: Schema.Array(Grant),
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  /**
   * `GET /api/mcp/:id/status`: a first-class server's status line (ADR 0043), read from its status tool as the owner;
   * null until its status tool is allowed, or when its answer does not fit.
   */
  HttpApiEndpoint.get('serverStatus', '/mcp/:id/status', {
    params: { id: ConnectionParam },
    success: Schema.NullOr(WalletStatus),
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  /** `GET /api/mcp/:id/spending`: a first-class server's paid tool and the owner's rule for it (ADR 0044). */
  HttpApiEndpoint.get('spending', '/mcp/:id/spending', {
    params: { id: ConnectionParam },
    success: Schema.NullOr(SpendingView),
    error: [ApiErrors.notFound],
  }),
  /** `PUT /api/mcp/:id/spending`: sets the rule (a null `perJob` removes it: every job asks first again). */
  HttpApiEndpoint.put('setSpending', '/mcp/:id/spending', {
    params: { id: ConnectionParam },
    payload: SpendingChange,
    success: Schema.NullOr(SpendingView),
    error: [ApiErrors.notFound],
  }),
  /** `POST /api/mcp/:id/step-up`: sign in again with more access (ADR 0042); the URL to open, in a new tab. */
  HttpApiEndpoint.post('stepUp', '/mcp/:id/step-up', {
    params: { id: ConnectionParam },
    payload: StepUp,
    success: ConnectStart,
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  HttpApiEndpoint.post('disconnect', '/mcp/:id/disconnect', {
    params: { id: ConnectionParam },
    success: Schema.Null,
    error: ApiErrors.notFound,
  }),
  HttpApiEndpoint.post('removeServer', '/mcp/:id/remove', {
    params: { id: ConnectionParam },
    success: Schema.Null,
    error: ApiErrors.invalidInput,
  }),
  HttpApiEndpoint.post('callTool', '/mcp/:id/tools/call', {
    params: { id: ConnectionParam },
    headers: Caller,
    payload: ToolCall,
    success: McpToolResult,
    error: [ApiErrors.notFound, ApiErrors.payloadTooLarge, ...REMOTE],
  }),
  HttpApiEndpoint.post('readResource', '/mcp/:id/resources/read', {
    params: { id: ConnectionParam },
    headers: Caller,
    payload: ResourceRead,
    success: McpResourceResult,
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  HttpApiEndpoint.get('oauthCallback', '/mcp/oauth/callback', { success: HttpApiSchema.Empty(302) }).annotate(
    RenewsResident,
    false,
  ),
) {}
