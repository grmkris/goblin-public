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
 * signing in, exact grants and calling a tool by hand. Keys are `[feature, kind, input]`; each change settles once
 * what it changed is fresh. Remote results are the server's, untrusted.
 */

/** The owner's servers, with where each stands. */
export const serversQuery = owner.apiQuery({ queryKey: ['mcp', 'servers'], queryFn: (api) => api.mcp.servers() })
/** Servers we suggest, each saying whether it is already added. */
export const suggestedQuery = owner.apiQuery({ queryKey: ['mcp', 'suggested'], queryFn: (api) => api.mcp.suggested() })
/** The registries searched: the built-in ones, then the owner's own. */
export const registriesQuery = owner.apiQuery({
  queryKey: ['mcp', 'registries'],
  queryFn: (api) => api.mcp.registries(),
})
/** Every exact grant the owner made. */
export const grantsQuery = owner.apiQuery({ queryKey: ['mcp', 'grants'], queryFn: (api) => api.mcp.grants() })

const catalogKey = (q: string | undefined): readonly ['mcp', 'catalog', string | undefined] => ['mcp', 'catalog', q]
/** The registries' entries matching `q`. */
export const catalogQuery = (q: string) =>
  owner.apiQuery({ queryKey: catalogKey(q), queryFn: (api) => api.mcp.catalog({ query: { q } }) })
/** The catalog search once there is something to search for. */
export const optionalCatalogQuery = (q: string | undefined) =>
  queryOptions({ queryKey: catalogKey(q), queryFn: q === undefined ? skipToken : catalogQuery(q).queryFn })

/** A connected server's discovered tools, each with its grant. */
export const toolsQuery = (serverId: string) =>
  owner.apiQuery({
    queryKey: ['mcp', 'tools', serverId],
    queryFn: (api) => api.mcp.tools({ params: { id: serverId }, query: {} }),
  })
/** A server's tools once it is connected; before then the key holds nothing. */
export const connectedToolsQuery = (serverId: string, connected: boolean) =>
  queryOptions({
    queryKey: toolsQuery(serverId).queryKey,
    queryFn: connected ? toolsQuery(serverId).queryFn : skipToken,
  })

/** Reads the server list again, and the suggestions and search results, which say what is already added. */
export const serversChanged = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: serversQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: suggestedQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ['mcp', 'catalog'] }),
  ])

/** Adds a server by its endpoint (from a registry entry, with where it came from); it starts disconnected. */
export const addServerMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, server: { readonly endpoint: string; readonly source?: ServerSource }) =>
        api.mcp.addServer({ payload: server }),
    }),
    onSuccess: () => serversChanged(queryClient),
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
export const connectMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({ mutationFn: (api, serverId: string) => api.mcp.connect({ params: { id: serverId } }) }),
    onSuccess: (started) => (started.authorizationUrl === undefined ? serversChanged(queryClient) : undefined),
  })

/** Closes a server's connection; its grants stay. */
export const disconnectMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({ mutationFn: (api, serverId: string) => api.mcp.disconnect({ params: { id: serverId } }) }),
    onSuccess: () => serversChanged(queryClient),
  })

/** Removes an added server, with its sign-in and every grant. */
export const removeServerMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({ mutationFn: (api, serverId: string) => api.mcp.removeServer({ params: { id: serverId } }) }),
    onSuccess: () =>
      Promise.all([serversChanged(queryClient), queryClient.invalidateQueries({ queryKey: grantsQuery.queryKey })]),
  })

/** Asks the server for its tools again and keeps what it answers. */
export const refreshToolsMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, serverId: string) => api.mcp.tools({ params: { id: serverId }, query: { refresh: '1' } }),
    }),
    onSuccess: (tools, serverId) => {
      queryClient.setQueryData(toolsQuery(serverId).queryKey, tools)
      return serversChanged(queryClient)
    },
  })

/** Whether the agent follows a server's skills. */
export const setSkillsMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, change: { readonly serverId: string; readonly enabled: boolean }) =>
        api.mcp.setSkills({ payload: change }),
    }),
    onSuccess: () => serversChanged(queryClient),
  })

/** A tool as its switch shows it once a grant changed: a revoked tool no longer waits for the owner. */
const granted = (tool: ToolView, allowed: boolean): ToolView => ({
  ...tool,
  granted: allowed,
  askFirst: tool.granted === allowed ? tool.askFirst : false,
})

/** A grant change answers every grant; a server's tools list follows in the cache, as its switches show it. */
const grantsChanged = (
  queryClient: QueryClient,
  grants: readonly Grant[],
  serverId: string,
  change: (tool: ToolView) => ToolView,
): void => {
  queryClient.setQueryData(grantsQuery.queryKey, grants)
  queryClient.setQueryData(toolsQuery(serverId).queryKey, (tools) => tools?.map(change))
}

/** Grants or revokes one discovered tool. */
export const toolGrantMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({ mutationFn: (api, change: GrantChange) => api.mcp.setToolGrant({ payload: change }) }),
    onSuccess: (grants, { serverId, name, allowed }) =>
      grantsChanged(queryClient, grants, serverId, (tool) => (tool.name === name ? granted(tool, allowed) : tool)),
  })

/** Grants or revokes an MCP App as a whole, with its tools. */
export const appGrantMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({ mutationFn: (api, change: AppGrantChange) => api.mcp.setAppGrant({ payload: change }) }),
    onSuccess: (grants, { serverId, uri, allowed }) =>
      grantsChanged(queryClient, grants, serverId, (tool) =>
        tool.appResource === uri ? granted(tool, allowed) : tool,
      ),
  })

/** A granted tool's calls wait for the owner's decision, or no longer do. */
export const askFirstMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({ mutationFn: (api, change: AskFirstChange) => api.mcp.setAskFirst({ payload: change }) }),
    onSuccess: (grants, { serverId, name, enabled }) =>
      grantsChanged(queryClient, grants, serverId, (tool) =>
        tool.name === name ? { ...tool, askFirst: enabled } : tool,
      ),
  })

/** Adds a registry to search, or removes one of the owner's; the answer is the list as it is now. */
export const registryMutation = (queryClient: QueryClient) =>
  mutationOptions({
    ...owner.apiMutation({
      mutationFn: (api, change: { readonly url: string; readonly remove: boolean }) =>
        change.remove
          ? api.mcp.removeRegistry({ payload: { url: change.url } })
          : api.mcp.addRegistry({ payload: { url: change.url } }),
    }),
    onSuccess: (registries) => {
      queryClient.setQueryData(registriesQuery.queryKey, registries)
      return queryClient.invalidateQueries({ queryKey: ['mcp', 'catalog'] })
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
