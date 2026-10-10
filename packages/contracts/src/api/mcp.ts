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
  ToolCall,
  ToolView,
} from '../mcp.ts'
import { ApiErrors } from './errors.ts'

/** A server's id in a path, as the route has always matched it; anything else names no server (404). */
const ServerParam = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u))
/** A held call's id in a path (`mcp:<session>:<call>` for the model's): anything else names no approval (404). */
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
 * `GET /api/mcp/oauth/callback` is not here: it answers a redirect to `/connections`, not JSON, and stays a raw route.
 */
export class McpGroup extends HttpApiGroup.make('mcp').add(
  HttpApiEndpoint.get('servers', '/mcp/servers', { success: Schema.Array(ServerView) }),
  HttpApiEndpoint.post('addServer', '/mcp/servers', {
    payload: AddServer,
    success: ServerView.pipe(HttpApiSchema.status(201)),
    error: [ApiErrors.invalidInput, ApiErrors.internal],
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
  HttpApiEndpoint.get('tools', '/mcp/:id/tools', {
    params: { id: ServerParam },
    query: { refresh: Schema.optional(Schema.String) },
    success: Schema.Array(ToolView),
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  HttpApiEndpoint.post('connect', '/mcp/:id/connect', {
    params: { id: ServerParam },
    success: ConnectStart,
    error: [ApiErrors.notFound, ...REMOTE],
  }),
  HttpApiEndpoint.post('disconnect', '/mcp/:id/disconnect', {
    params: { id: ServerParam },
    success: Schema.Null,
    error: ApiErrors.notFound,
  }),
  HttpApiEndpoint.post('removeServer', '/mcp/:id/remove', {
    params: { id: ServerParam },
    success: Schema.Null,
    error: ApiErrors.invalidInput,
  }),
  HttpApiEndpoint.post('callTool', '/mcp/:id/tools/call', {
    params: { id: ServerParam },
    headers: Caller,
    payload: ToolCall,
    success: McpToolResult,
    error: [ApiErrors.notFound, ApiErrors.payloadTooLarge, ...REMOTE],
  }),
  HttpApiEndpoint.post('readResource', '/mcp/:id/resources/read', {
    params: { id: ServerParam },
    headers: Caller,
    payload: ResourceRead,
    success: McpResourceResult,
    error: [ApiErrors.notFound, ...REMOTE],
  }),
) {}
