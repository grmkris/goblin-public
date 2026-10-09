import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import type * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import { InvalidInput } from '../http/errors.ts'
import { AgentInput } from '../runtime/input.ts'
import { setSkillEvents } from '../skills/events.ts'
import { approvalView, decideOwnerApproval, ownerResource, setAskFirst } from './approval-owner.ts'
import { disconnectOwnerServer, ownerServers, removeOwnerServer, suggestedServers } from './program.ts'
import { McpConnections, McpGrants, McpServers } from './service.ts'

/** The mcp group's endpoints as the owner API serves them: behind the owner gate, which may answer any failure. */
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
  McpServers.use((offered) => offered.add(payload.endpoint, payload.source)),
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
  McpGrants.use((owned) => owned.setTool(payload.serverId, payload.name, payload.allowed)),
)
const setToolAskFirst = endpoint('setAskFirst')(({ payload }) =>
  setAskFirst(payload.serverId, payload.name, payload.enabled),
)
const setSkills = endpoint('setSkills')(({ payload }) => setSkillEvents(payload.serverId, payload.enabled))
const setAppGrant = endpoint('setAppGrant')(({ payload }) =>
  McpGrants.use((owned) => owned.setApp(payload.serverId, payload.uri, payload.allowed)),
)
const approval = endpoint('approval')(({ params }) => approvalView(params.id))
const decideApproval = endpoint('decideApproval')(({ params, payload }) =>
  decideOwnerApproval(params.id, payload.allowed),
)
const tools = endpoint('tools')(({ params, query }) =>
  McpServers.use((offered) => offered.tools(params.id, query.refresh !== undefined)),
)
const connect = endpoint('connect')(({ params }) => McpServers.use((offered) => offered.beginConnect(params.id)))
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
const getPrompt = endpoint('getPrompt')(({ params, payload }) =>
  McpConnections.use((connections) => connections.getPrompt(params.id, payload.name, payload.arguments ?? {})),
)

/**
 * The `mcp` group (ADRs 0003, 0005, 0006, 0008, 0028): each handler runs the program its Durable Object RPC method
 * ran, behind the owner gate. A decided held call goes on to its conversation as the owner's message, composed into
 * the decision rather than sent through the agent's own `submit`.
 */
export const McpHandlers = HttpApiBuilder.group(OwnerApi, 'mcp', (handlers) =>
  handlers.handleAll({
    servers,
    addServer,
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
    decideApproval,
    tools,
    connect,
    disconnect,
    removeServer,
    callTool,
    readResource,
    getPrompt,
  }),
)
