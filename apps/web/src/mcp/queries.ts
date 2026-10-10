import { type QueryClient, mutationOptions, queryOptions, skipToken } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import type {
  AddServer,
  AppGrantChange,
  AskFirstChange,
  ConnectStart,
  Grant,
  GrantChange,
  ServerSource,
  ToolView,
} from '@goblin/contracts'
import { owner } from '../lib/api.ts'

/**
 * The owner's MCP servers on the owner API (ADRs 0003, 0005, 0006, 0008, 0028): the servers and what to add more from,
 * signing in, exact grants and calling a tool by hand. Keys are `['mcp', kind, input]`; each change settles once
 * what it changed is fresh. Remote results are the server's, untrusted.
 */
export const mcpKeys = {
  servers: ['mcp', 'servers'] as const,
  suggested: ['mcp', 'suggested'] as const,
  registries: ['mcp', 'registries'] as const,
  grants: ['mcp', 'grants'] as const,
  catalogs: ['mcp', 'catalog'] as const,
  catalog: (q: string | undefined): readonly ['mcp', 'catalog', string | undefined] => ['mcp', 'catalog', q],
  tools: (serverId: string) => ['mcp', 'tools', serverId] as const,
}

/** The owner's servers, with where each stands. */
export const serversQuery = owner.apiQuery({ queryKey: mcpKeys.servers, queryFn: (api) => api.mcp.servers() })
/** Servers we suggest, each saying whether it is already added. */
export const suggestedQuery = owner.apiQuery({ queryKey: mcpKeys.suggested, queryFn: (api) => api.mcp.suggested() })
/** The registries searched: the built-in ones, then the owner's own. */
export const registriesQuery = owner.apiQuery({
  queryKey: mcpKeys.registries,
  queryFn: (api) => api.mcp.registries(),
})
/** Every exact grant the owner made. */
export const grantsQuery = owner.apiQuery({ queryKey: mcpKeys.grants, queryFn: (api) => api.mcp.grants() })

/** The registries' entries matching `q`, and whether a registry could not be searched. */
const catalogQuery = (q: string) =>
  owner.apiQuery({ queryKey: mcpKeys.catalog(q), queryFn: (api) => api.mcp.catalog({ query: { q } }) })
/** The catalog search once there is something to search for. */
export const optionalCatalogQuery = (q: string | undefined) =>
  queryOptions({ queryKey: mcpKeys.catalog(q), queryFn: q === undefined ? skipToken : catalogQuery(q).queryFn })

/** A connected server's discovered tools, each with its grant. */
export const toolsQuery = (serverId: string) =>
  owner.apiQuery({
    queryKey: mcpKeys.tools(serverId),
    queryFn: (api) => api.mcp.tools({ params: { id: serverId }, query: {} }),
  })
/** A server's tools once it is connected; before then the key holds nothing. */
export const connectedToolsQuery = (serverId: string, connected: boolean) =>
  queryOptions({
    queryKey: mcpKeys.tools(serverId),
    queryFn: connected ? toolsQuery(serverId).queryFn : skipToken,
  })

/** Reads the server list again, and the suggestions and search results, which say what is already added. */
export const serversChanged = (client: QueryClient) =>
  Promise.all([
    client.invalidateQueries({ queryKey: mcpKeys.servers }),
    client.invalidateQueries({ queryKey: mcpKeys.suggested }),
    client.invalidateQueries({ queryKey: mcpKeys.catalogs }),
  ])

/** Adds a server by its endpoint (from a registry entry, with where it came from); it starts disconnected. */
export const addServerMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, server: { readonly endpoint: string; readonly source?: ServerSource }) =>
      api.mcp.addServer({ payload: server }),
  }),
  onSuccess: (_server, _added, _result, { client }) => serversChanged(client),
})

/**
 * Adds a server and starts connecting it, in one call from wherever the owner said yes (a suggestion, a registry entry,
 * a card in the conversation): the authorization URL to send the owner to, or none when it is connected at once.
 */
export const addAndStartConnecting = (server: AddServer): Promise<ConnectStart> =>
  owner.run((api) =>
    Effect.flatMap(api.mcp.addServer({ payload: server }), (added) =>
      api.mcp.connect({ params: { id: added.serverId } }),
    ),
  )

/** Starts connecting: an authorization URL to send the owner to, or none when the server is connected at once. */
export const connectMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, serverId: string) => api.mcp.connect({ params: { id: serverId } }) }),
  onSuccess: (started, _serverId, _result, { client }) =>
    started.authorizationUrl === undefined ? serversChanged(client) : undefined,
})

/** Closes a server's connection; its grants stay. */
export const disconnectMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, serverId: string) => api.mcp.disconnect({ params: { id: serverId } }) }),
  onSuccess: (_closed, _serverId, _result, { client }) => serversChanged(client),
})

/** Removes an added server, with its sign-in and every grant. */
export const removeServerMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, serverId: string) => api.mcp.removeServer({ params: { id: serverId } }) }),
  onSuccess: (_removed, _serverId, _result, { client }) =>
    Promise.all([serversChanged(client), client.invalidateQueries({ queryKey: mcpKeys.grants })]),
})

/** Asks the server for its tools again and keeps what it answers. */
export const refreshToolsMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, serverId: string) => api.mcp.tools({ params: { id: serverId }, query: { refresh: '1' } }),
  }),
  onSuccess: (tools, serverId, _result, { client }) => {
    client.setQueryData(toolsQuery(serverId).queryKey, tools)
    return serversChanged(client)
  },
})

/** Whether the agent follows a server's skills. */
export const setSkillsMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, change: { readonly serverId: string; readonly enabled: boolean }) =>
      api.mcp.setSkills({ payload: change }),
  }),
  onSuccess: (_servers, _change, _result, { client }) => serversChanged(client),
})

/** A tool as its switch shows it once a grant changed: a revoked tool no longer waits for the owner. */
const granted = (tool: ToolView, allowed: boolean): ToolView => ({
  ...tool,
  granted: allowed,
  askFirst: tool.granted === allowed ? tool.askFirst : false,
})

/** A grant change answers every grant; a server's tools list follows in the cache, as its switches show it. */
const grantsChanged = (
  client: QueryClient,
  grants: readonly Grant[],
  serverId: string,
  change: (tool: ToolView) => ToolView,
): void => {
  client.setQueryData(grantsQuery.queryKey, grants)
  client.setQueryData(toolsQuery(serverId).queryKey, (tools) => tools?.map(change))
}

/** Grants or revokes one discovered tool, from its switch or from an App that asked for it. */
export const toolGrantMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, change: GrantChange) => api.mcp.setToolGrant({ payload: change }) }),
  onSuccess: (grants, { serverId, name, allowed }, _result, { client }) =>
    grantsChanged(client, grants, serverId, (tool) => (tool.name === name ? granted(tool, allowed) : tool)),
})

/** Grants or revokes an MCP App as a whole, with its tools. */
export const appGrantMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, change: AppGrantChange) => api.mcp.setAppGrant({ payload: change }) }),
  onSuccess: (grants, { serverId, uri, allowed }, _result, { client }) =>
    grantsChanged(client, grants, serverId, (tool) => (tool.appResource === uri ? granted(tool, allowed) : tool)),
})

/** A granted tool's calls wait for the owner's decision, or no longer do. */
export const askFirstMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, change: AskFirstChange) => api.mcp.setAskFirst({ payload: change }) }),
  onSuccess: (grants, { serverId, name, enabled }, _result, { client }) =>
    grantsChanged(client, grants, serverId, (tool) => (tool.name === name ? { ...tool, askFirst: enabled } : tool)),
})

/** Adds a registry to search, or removes one of the owner's; the answer is the list as it is now. */
export const registryMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, change: { readonly url: string; readonly remove: boolean }) =>
      change.remove
        ? api.mcp.removeRegistry({ payload: { url: change.url } })
        : api.mcp.addRegistry({ payload: { url: change.url } }),
  }),
  onSuccess: (registries, _change, _result, { client }) => {
    client.setQueryData(registriesQuery.queryKey, registries)
    return client.invalidateQueries({ queryKey: mcpKeys.catalogs })
  },
})

/** Calls one granted tool by hand; the result is the server's, shown as remote data. */
export const callToolMutation = owner.apiMutation({
  mutationFn: (
    api,
    call: { readonly serverId: string; readonly name: string; readonly arguments: Record<string, unknown> },
  ) =>
    api.mcp.callTool({
      params: { id: call.serverId },
      headers: {},
      payload: { name: call.name, arguments: call.arguments },
    }),
})
