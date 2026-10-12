import { type QueryClient, mutationOptions, queryOptions, skipToken } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import type {
  AddServer,
  AppGrantChange,
  AskFirstChange,
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
  tools: (connectionId: string) => ['mcp', 'tools', connectionId] as const,
  status: (connectionId: string) => ['mcp', 'status', connectionId] as const,
  app: (connectionId: string, tool: string) => ['mcp', 'app', connectionId, tool] as const,
  events: (connectionId: string) => ['mcp', 'events', connectionId] as const,
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
export const toolsQuery = (connectionId: string) =>
  owner.apiQuery({
    queryKey: mcpKeys.tools(connectionId),
    queryFn: (api) => api.mcp.tools({ params: { id: connectionId }, query: {} }),
  })
/** A server's tools once it is connected; before then the key holds nothing. */
export const connectedToolsQuery = (connectionId: string, connected: boolean) =>
  queryOptions({
    queryKey: mcpKeys.tools(connectionId),
    queryFn: connected ? toolsQuery(connectionId).queryFn : skipToken,
  })

/**
 * The event streams a connection's server sends (ADR 0041), each with the schema of its filters: the server's claims,
 * untrusted. Nothing is read for no connection.
 */
export const eventsQuery = (connectionId: string | undefined) =>
  queryOptions({
    queryKey: mcpKeys.events(connectionId ?? ''),
    queryFn:
      connectionId === undefined
        ? skipToken
        : owner.apiQuery({
            queryKey: mcpKeys.events(connectionId),
            queryFn: (api) => api.mcp.events({ params: { id: connectionId } }),
          }).queryFn,
  })

/** The owner wants nothing from a connection's events: its offer stops asking, here and in Activity (ADR 0041). */
export const dismissEventsMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, connectionId: string) => api.mcp.dismissEvents({ params: { id: connectionId } }),
  }),
  onSuccess: (_dismissed, _connection, _result, { client }) => client.invalidateQueries({ queryKey: mcpKeys.servers }),
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
 * a card in the conversation): the authorization URL to send the owner to, or none when it is connected at once. A
 * page that leaves for the authorization reads the list when it comes back.
 */
export const addAndConnectMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, server: AddServer) =>
      Effect.flatMap(api.mcp.addServer({ payload: server }), (added) =>
        api.mcp.connect({ params: { id: added.connectionId } }),
      ),
  }),
  onSuccess: (started, _server, _result, { client }) =>
    started.authorizationUrl === undefined ? serversChanged(client) : undefined,
})

/** Names a connection anew (ADR 0041); a label another connection holds is refused (409). */
export const renameConnectionMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, change: { readonly connectionId: string; readonly label: string }) =>
      api.mcp.renameConnection({ params: { id: change.connectionId }, payload: { label: change.label } }),
  }),
  onSuccess: (_server, _change, _result, { client }) => serversChanged(client),
})

/** Starts connecting: an authorization URL to send the owner to, or none when the server is connected at once. */
export const connectMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, connectionId: string) => api.mcp.connect({ params: { id: connectionId } }),
  }),
  onSuccess: (started, _connectionId, _result, { client }) =>
    started.authorizationUrl === undefined ? serversChanged(client) : undefined,
})

/** What a step-up asks for: the connection, and the scope the server said the call needs. */
export type StepUpRequest = { readonly connectionId: string; readonly scope: string }

/**
 * Starts signing a connection in again with more access (ADR 0042): the consent URL to open in a new tab. The
 * connection keeps working with its current access until the new sign-in completes.
 */
export const stepUpMutation = owner.apiMutation({
  mutationFn: (api, { connectionId, scope }: StepUpRequest) =>
    api.mcp.stepUp({ params: { id: connectionId }, payload: { scope } }),
})

/** Closes a server's connection; its grants stay. */
export const disconnectMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, connectionId: string) => api.mcp.disconnect({ params: { id: connectionId } }),
  }),
  onSuccess: (_closed, _connectionId, _result, { client }) => serversChanged(client),
})

/** Removes an added server, with its sign-in and every grant. */
export const removeServerMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, connectionId: string) => api.mcp.removeServer({ params: { id: connectionId } }),
  }),
  onSuccess: (_removed, _connectionId, _result, { client }) =>
    Promise.all([serversChanged(client), client.invalidateQueries({ queryKey: mcpKeys.grants })]),
})

/** Asks the server for its tools again and keeps what it answers. */
export const refreshToolsMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, connectionId: string) => api.mcp.tools({ params: { id: connectionId }, query: { refresh: '1' } }),
  }),
  onSuccess: (tools, connectionId, _result, { client }) => {
    client.setQueryData(toolsQuery(connectionId).queryKey, tools)
    return serversChanged(client)
  },
})

/** Whether the agent follows a server's skills. */
export const setSkillsMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, change: { readonly connectionId: string; readonly enabled: boolean }) =>
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
  connectionId: string,
  change: (tool: ToolView) => ToolView,
): void => {
  client.setQueryData(grantsQuery.queryKey, grants)
  client.setQueryData(toolsQuery(connectionId).queryKey, (tools) => tools?.map(change))
}

/** Grants or revokes one discovered tool, from its switch or from an App that asked for it. */
export const toolGrantMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, change: GrantChange) => api.mcp.setToolGrant({ payload: change }) }),
  onSuccess: (grants, { connectionId, name, allowed }, _result, { client }) =>
    grantsChanged(client, grants, connectionId, (tool) => (tool.name === name ? granted(tool, allowed) : tool)),
})

/** Grants or revokes an MCP App as a whole, with its tools. */
export const appGrantMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, change: AppGrantChange) => api.mcp.setAppGrant({ payload: change }) }),
  onSuccess: (grants, { connectionId, uri, allowed }, _result, { client }) =>
    grantsChanged(client, grants, connectionId, (tool) => (tool.appResource === uri ? granted(tool, allowed) : tool)),
})

/** A granted tool's calls wait for the owner's decision, or no longer do. */
export const askFirstMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, change: AskFirstChange) => api.mcp.setAskFirst({ payload: change }) }),
  onSuccess: (grants, { connectionId, name, enabled }, _result, { client }) =>
    grantsChanged(client, grants, connectionId, (tool) => (tool.name === name ? { ...tool, askFirst: enabled } : tool)),
})

/**
 * A first-class server's recommended grants, applied in one go (ADR 0043): its free tools run when needed, its paid
 * ones ask first. Its tools and status line are read again.
 */
export const allowRecommendedMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, connectionId: string) => api.mcp.allowRecommended({ params: { id: connectionId } }),
  }),
  onSuccess: (grants, connectionId, _result, { client }) => {
    client.setQueryData(grantsQuery.queryKey, grants)
    return Promise.all([
      client.invalidateQueries({ queryKey: mcpKeys.tools(connectionId) }),
      client.invalidateQueries({ queryKey: mcpKeys.status(connectionId) }),
    ])
  },
})

/** A first-class server's status line (its wallet), once it is connected; null until its status tool is allowed. */
export const serverStatusQuery = (connectionId: string, connected: boolean) =>
  queryOptions({
    queryKey: mcpKeys.status(connectionId),
    queryFn: connected
      ? owner.apiQuery({
          queryKey: mcpKeys.status(connectionId),
          queryFn: (api) => api.mcp.serverStatus({ params: { id: connectionId } }),
        }).queryFn
      : skipToken,
    staleTime: 60_000,
  })

/**
 * A first-class server's own App, as the owner opens it (ADR 0043): its app tool called as the owner, and the `ui://`
 * resource that tool declares; nothing to show when the tool declares none. Read again on each open.
 */
export const serverAppQuery = (connectionId: string, tool: string) => ({
  ...owner.apiQuery({
    queryKey: mcpKeys.app(connectionId, tool),
    queryFn: (api) =>
      Effect.map(
        Effect.all([
          api.mcp.callTool({ params: { id: connectionId }, headers: {}, payload: { name: tool } }),
          api.mcp.tools({ params: { id: connectionId }, query: {} }),
        ]),
        ([result, tools]) => ({ result, uri: tools.find((each) => each.name === tool)?.appResource }),
      ),
  }),
  staleTime: 0,
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
    call: { readonly connectionId: string; readonly name: string; readonly arguments: Record<string, unknown> },
  ) =>
    api.mcp.callTool({
      params: { id: call.connectionId },
      headers: {},
      payload: { name: call.name, arguments: call.arguments },
    }),
})
