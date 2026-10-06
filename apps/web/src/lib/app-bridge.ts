import { AppBridge, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client'
import type { AppSelection, FrameEvents, McpSelection } from '../components/apps/frame.tsx'
import { contextText, safeLink } from './app-context.ts'
import { appSandbox } from './app-sandbox.ts'
import { grantDenied } from '../components/apps/grant-ask.tsx'
import { type AgentAppCalls, type StatePush, agentBridge } from './agent-app-bridge.ts'

export type AppCalls = {
  /** An agent app's routes; an MCP App uses `tool` and `resource`. */
  readonly agent: AgentAppCalls
  readonly tool: (
    serverId: string,
    params: { name: string; arguments: Record<string, unknown> },
  ) => Promise<CallToolResult>
  readonly resource: (serverId: string, params: { uri: string }) => Promise<ReadResourceResult>
}

/** An MCP App's handlers: its calls and reads go to its own server under the owner's grants, live. */
function mcpBridge(bridge: AppBridge, selection: McpSelection, calls: AppCalls, events: FrameEvents): void {
  const { serverId } = selection
  bridge.oncalltool = async (params) => {
    const call = () => calls.tool(serverId, { name: params.name, arguments: params.arguments ?? {} })
    try {
      return await call()
    } catch (cause) {
      // An ungranted tool waits for the owner instead of failing; allowed, the same call runs once more.
      if (grantDenied(cause) && (await events.askGrant(params.name))) return call()
      throw cause
    }
  }
  bridge.onreadresource = (params) => calls.resource(serverId, { uri: params.uri })
  bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
    events.share(contextText(content, structuredContent))
    return {}
  }
  bridge.addEventListener('initialized', () => {
    void bridge
      .sendToolInput({ arguments: selection.arguments })
      .then(() => bridge.sendToolResult(selection.result))
      .catch(() => events.report('App initialization failed'))
  })
}

/**
 * The host side of one App's frame: an MCP App's or an agent app's own handlers, then what every App shares (display
 * modes, links, size, teardown, loading its document). An agent app's bridge also returns what pushes its state.
 */
export function createAppBridge(
  selection: AppSelection,
  html: string,
  context: McpUiHostContext,
  calls: AppCalls,
  events: FrameEvents,
): { readonly bridge: AppBridge; readonly push?: StatePush } {
  const bridge = new AppBridge(
    null,
    { name: 'goblin', version: '0.1.0' },
    selection.kind === 'mcp'
      ? { serverTools: {}, serverResources: {}, openLinks: {}, updateModelContext: { text: {}, structuredContent: {} } }
      : { serverTools: {}, openLinks: {}, logging: {} },
    { hostContext: context },
  )
  bridge.onrequestdisplaymode = async ({ mode }) => ({ mode: events.requestMode(mode) })
  bridge.onopenlink = async ({ url }) => {
    const link = safeLink(url)
    if (link === undefined) return { isError: true }
    events.offerLink(link)
    return {}
  }
  bridge.addEventListener('sizechange', ({ height }) => {
    if (height !== undefined) events.resize(height)
  })
  bridge.addEventListener('requestteardown', () => events.close())
  bridge.addEventListener('sandboxready', () => {
    void bridge
      .sendSandboxResourceReady({ html, sandbox: appSandbox(selection.kind) })
      .catch(() => events.report('App resource could not be loaded'))
  })
  if (selection.kind === 'mcp') {
    mcpBridge(bridge, selection, calls, events)
    return { bridge }
  }
  const { launch } = selection
  const first = { revision: launch.revision, release: launch.release, state: launch.state }
  return { bridge, push: agentBridge(bridge, { id: selection.id, first }, calls.agent, events.report) }
}
