// An App's server data (ADRs 0020, 0021) through the owner's typed client: what the browser loads an App with, and the
// calls its frame makes. An agent app's view reads its state, calls its actions and reports its failures; an MCP App
// calls its own server's tools and resources, as the App, under the owner's grants. Keys are [feature, kind, input].
import { MutationObserver, type MutationOptions, type QueryClient, queryOptions } from '@tanstack/react-query'
import type { AppCall, CreateApp, ResourceRead, ToolCall } from '@goblin/contracts'
import { owner } from '../lib/api.ts'

const appKeys = {
  launch: (id: string) => ['apps', 'launch', id] as const,
  state: (id: string) => ['apps', 'state', id] as const,
}

/**
 * What the browser loads App `id` with. Read fresh each time and not kept: an agent app's new release loads in place
 * of the old one, and a launch carries the view's code.
 */
export const appLaunchQuery = (id: string) =>
  queryOptions({
    ...owner.apiQuery({ queryKey: appKeys.launch(id), queryFn: (api) => api.apps.launch({ params: { id } }) }),
    staleTime: 0,
    gcTime: 0,
  })

/** An agent app's state now, for its frame: read fresh, because the feed said it moved. */
export const appStateQuery = (id: string) =>
  queryOptions({
    ...owner.apiQuery({ queryKey: appKeys.state(id), queryFn: (api) => api.apps.state({ params: { id } }) }),
    staleTime: 0,
    gcTime: 0,
  })

/** Keeps the App of call `callId` in a conversation, reopening it if it was closed; the workspace feed shows it. */
export const keepAppMutation = owner.apiMutation({
  mutationFn: (api, keep: CreateApp) => api.apps.create({ payload: keep }),
})

/** Closes a kept App, or opens a closed one again; the workspace feed shows it. */
export const appClosedMutation = owner.apiMutation({
  mutationFn: (api, { id, closed }: { readonly id: string; readonly closed: boolean }) =>
    api.apps.update({ params: { id }, payload: { closed } }),
})

/** One of agent app `id`'s actions, called by its view with the frame's operation id. */
export const appCallMutation = owner.apiMutation({
  mutationFn: (api, { id, call }: { readonly id: string; readonly call: AppCall }) =>
    api.apps.call({ params: { id }, payload: call }),
})

/** A failure agent app `id`'s view reported, kept where the agent sees it. */
export const appDiagnosticMutation = owner.apiMutation({
  mutationFn: (api, { id, message }: { readonly id: string; readonly message: string }) =>
    api.apps.diagnostics({ params: { id }, payload: { message } }),
})

/** An MCP App's tool call to its own server: `x-mcp-caller: app` narrows it to what the App may use. */
export const appToolCallMutation = owner.apiMutation({
  mutationFn: (api, { serverId, call }: { readonly serverId: string; readonly call: ToolCall }) =>
    api.mcp.callTool({ params: { id: serverId }, headers: { 'x-mcp-caller': 'app' }, payload: call }),
})

/** An MCP App's resource read from its own server, as the App. */
export const appResourceReadMutation = owner.apiMutation({
  mutationFn: (api, { serverId, read }: { readonly serverId: string; readonly read: ResourceRead }) =>
    api.mcp.readResource({ params: { id: serverId }, headers: { 'x-mcp-caller': 'app' }, payload: read }),
})

/**
 * Runs `options` outside a component, as `useMutation` would: through the client's mutation cache, so an ended session
 * sends the owner to sign in from an App's call too.
 */
export const perform = <Data, Failure, Variables>(
  queryClient: QueryClient,
  options: MutationOptions<Data, Failure, Variables>,
  variables: Variables,
): Promise<Data> => new MutationObserver(queryClient, options).mutate(variables)
