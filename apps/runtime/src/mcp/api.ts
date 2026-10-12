import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import type * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import { RequestContext } from '../http/api/context.ts'
import { InvalidInput } from '../http/errors.ts'
import { withFlow } from '../observability/flows.ts'
import { AgentInput } from '../runtime/input.ts'
import { setSkillEvents } from '../skills/events.ts'
import { challengeScope } from './errors.ts'
import { eventSuggestion } from './events/protocol.ts'
import {
  answerOwnerUrlRequest,
  approvalView,
  decideOwnerApproval,
  ownerResource,
  setAskFirst,
} from './approval-owner.ts'
import {
  allowRecommended as allowRecommendedGrants,
  setSpending as setSpendingRule,
  setTopUp as setTopUpRule,
  serverStatus as statusOf,
  spendingView,
  topUpView,
} from './first-class-owner.ts'
import { urlRequestView } from './url-request.ts'
import { connectCallback, disconnectOwnerServer, ownerServers, removeOwnerServer, suggestedServers } from './program.ts'
import { Events, McpConnections, McpGrants, McpServers } from './service.ts'

/** The mcp group's endpoints as the owner API serves them: behind owner admission, which may answer any failure. */
type Endpoints = (typeof OwnerApi.groups)['mcp']['endpoints']

/** The handler of the endpoint `name`, typed by the contract: each is written once below, then the group lists them. */
const endpoint =
  <Name extends keyof Endpoints>(_name: Name) =>
  <R>(handler: HttpApiEndpoint.Handler<Endpoints[Name], HttpApiEndpoint.MiddlewareError<Endpoints[Name]>, R>) =>
    handler

/** The longest catalog search the owner may run. */
const MAX_QUERY = 100

/** `x-mcp-caller: app` is an App the owner opened; anything else is the owner by hand. */
const callerOf = (header: string | undefined): 'human' | 'app' => (header === 'app' ? 'app' : 'human')

const servers = endpoint('servers')(() => ownerServers)
const addServer = endpoint('addServer')(({ payload }) =>
  McpServers.use((offered) => offered.add(payload.endpoint, payload.label, payload.source)),
)
const renameConnection = endpoint('renameConnection')(({ params, payload }) =>
  McpServers.use((offered) => offered.rename(params.id, payload.label)),
)
const dismissEvents = endpoint('dismissEvents')(({ params }) =>
  Effect.as(
    McpServers.use((offered) => offered.settleEvents(params.id, 'dismissed')),
    null,
  ),
)
const suggested = endpoint('suggested')(() => AgentInput.use(({ env }) => suggestedServers(env.STAGE)))
const catalog = endpoint('catalog')(({ query }) => {
  const text = query.q ?? ''
  return text.length > MAX_QUERY
    ? Effect.fail(new InvalidInput({ reason: 'query_too_long' }))
    : McpServers.use((offered) => offered.catalog(text))
})
const registries = endpoint('registries')(() => McpServers.use((offered) => offered.registries()))
const addRegistry = endpoint('addRegistry')(({ payload }) =>
  McpServers.use((offered) => offered.addRegistry(payload.url)),
)
const removeRegistry = endpoint('removeRegistry')(({ payload }) =>
  McpServers.use((offered) => offered.removeRegistry(payload.url)),
)
const grants = endpoint('grants')(() => McpGrants.use((owned) => owned.list()))
const setToolGrant = endpoint('setToolGrant')(({ payload }) =>
  McpGrants.use((owned) => owned.setTool(payload.connectionId, payload.name, payload.allowed)),
)
const setToolAskFirst = endpoint('setAskFirst')(({ payload }) =>
  setAskFirst(payload.connectionId, payload.name, payload.enabled),
)
const setSkills = endpoint('setSkills')(({ payload }) => setSkillEvents(payload.connectionId, payload.enabled))
const setAppGrant = endpoint('setAppGrant')(({ payload }) =>
  McpGrants.use((owned) => owned.setApp(payload.connectionId, payload.uri, payload.allowed)),
)
const approval = endpoint('approval')(({ params }) => approvalView(params.id))
/** The longest description of an event stream the owner reads; the rest of a server's claim is cut. */
const EVENT_DESCRIPTION = 500
/** Each stream with the server's suggestions for it (ADR 0041): claims that pre-select, never grant. */
const events = endpoint('events')(({ params }) =>
  Events.use((offered) => offered.catalog(params.id)).pipe(
    Effect.map((descriptors) =>
      descriptors.map((descriptor) => ({
        name: descriptor.name,
        ...(descriptor.description === undefined
          ? {}
          : { description: descriptor.description.slice(0, EVENT_DESCRIPTION) }),
        inputSchema: descriptor.inputSchema,
        subscribable: descriptor.delivery.includes('poll') && descriptor.delivery.includes('webhook'),
        ...eventSuggestion(descriptor),
      })),
    ),
  ),
)
const decideApproval = endpoint('decideApproval')(({ params, payload }) =>
  decideOwnerApproval(params.id, payload.allowed, payload.runUpTo),
)
const urlRequest = endpoint('urlRequest')(({ params }) => urlRequestView(params.id))
const answerUrlRequest = endpoint('answerUrlRequest')(({ params, payload }) =>
  answerOwnerUrlRequest(params.id, payload.action),
)
const tools = endpoint('tools')(({ params, query }) =>
  McpServers.use((offered) => offered.tools(params.id, query.refresh !== undefined)),
)
const connect = endpoint('connect')(({ params, payload }) =>
  McpServers.use((offered) => offered.beginConnect(params.id, payload.scope)),
)
const access = endpoint('access')(({ params }) => McpServers.use((offered) => offered.access(params.id)))
const stepUp = endpoint('stepUp')(({ params, payload }) =>
  McpServers.use((offered) => offered.beginStepUp(params.id, challengeScope(payload.scope))).pipe(
    withFlow({ flow: 'step_up', via: 'app', actor: 'owner' }),
  ),
)
const allowRecommended = endpoint('allowRecommended')(({ params }) => allowRecommendedGrants(params.id))
const spending = endpoint('spending')(({ params }) => spendingView(params.id))
const setSpending = endpoint('setSpending')(({ params, payload }) => setSpendingRule(params.id, payload))
const serverStatus = endpoint('serverStatus')(({ params }) => statusOf(params.id))
const topUp = endpoint('topUp')(({ params }) => topUpView(params.id))
const setTopUp = endpoint('setTopUp')(({ params, payload }) => setTopUpRule(params.id, payload))
const disconnect = endpoint('disconnect')(({ params }) => disconnectOwnerServer(params.id))
const removeServer = endpoint('removeServer')(({ params }) => removeOwnerServer(params.id))
const callTool = endpoint('callTool')(({ params, headers, payload }) =>
  McpConnections.use((connections) =>
    connections.callTool(params.id, payload.name, payload.arguments ?? {}, {
      caller: callerOf(headers['x-mcp-caller']),
    }),
  ),
)
const readResource = endpoint('readResource')(({ params, headers, payload }) =>
  ownerResource(params.id, payload.uri, callerOf(headers['x-mcp-caller'])),
)

/**
 * An outbound sign-in coming back (the provider's redirect, its query whole): to Connections, quoting the request's
 * reference when it failed.
 */
const oauthCallback = ({ request }: { readonly request: HttpServerRequest.HttpServerRequest }) =>
  Effect.gen(function* () {
    const appUrl = yield* AgentInput.useSync(({ env }) => env.APP_URL)
    const location = yield* connectCallback(new URL(request.originalUrl).searchParams, appUrl)
    const ref = Option.getOrUndefined(yield* Effect.serviceOption(RequestContext))?.ref
    if (location.searchParams.has('error') && ref !== undefined) location.searchParams.set('ref', ref)
    return HttpServerResponse.redirect(location, { status: 302 })
  })

/**
 * The `mcp` group (ADRs 0003, 0005, 0006, 0008, 0028, 0043): each handler runs its program, behind owner admission.
 * A decided held call goes on to its conversation as an outcome, composed into the decision rather than sent through
 * the agent's own `submit`.
 */
export const McpHandlers = HttpApiBuilder.group(OwnerApi, 'mcp', (handlers) =>
  handlers
    .handleAll({
      servers,
      addServer,
      renameConnection,
      suggested,
      catalog,
      registries,
      addRegistry,
      removeRegistry,
      grants,
      setToolGrant,
      setAskFirst: setToolAskFirst,
      setSkills,
      setAppGrant,
      approval,
      events,
      dismissEvents,
      decideApproval,
      urlRequest,
      answerUrlRequest,
      tools,
      connect,
      access,
      stepUp,
      allowRecommended,
      serverStatus,
      spending,
      setSpending,
      topUp,
      setTopUp,
      disconnect,
      removeServer,
      callTool,
      readResource,
    })
    .handleRaw('oauthCallback', oauthCallback),
)
