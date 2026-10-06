import { AppBridge, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client'
import type { AppSelection, FrameEvents } from '../components/apps/frame.tsx'
import { contextText, safeLink } from './app-context.ts'
import { grantDenied } from '../components/apps/grant-ask.tsx'

export type AppCalls = {
  readonly tool: (
    serverId: string,
    params: { name: string; arguments: Record<string, unknown> },
  ) => Promise<CallToolResult>
  readonly resource: (serverId: string, params: { uri: string }) => Promise<ReadResourceResult>
}

export function createAppBridge(
  selection: AppSelection,
  html: string,
  context: McpUiHostContext,
  calls: AppCalls,
  events: FrameEvents,
): AppBridge {
  const bridge = new AppBridge(
    null,
    { name: 'goblin', version: '0.1.0' },
    { serverTools: {}, serverResources: {}, openLinks: {}, updateModelContext: { text: {}, structuredContent: {} } },
    { hostContext: context },
  )
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
  bridge.onrequestdisplaymode = async ({ mode }) => ({ mode: events.requestMode(mode) })
  bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
    events.share(contextText(content, structuredContent))
    return {}
  }
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
      .sendSandboxResourceReady({ html, sandbox: 'allow-scripts' })
      .catch(() => events.report('App resource could not be loaded'))
  })
  bridge.addEventListener('initialized', () => {
    void bridge
      .sendToolInput({ arguments: selection.arguments })
      .then(() => bridge.sendToolResult(selection.result))
      .catch(() => events.report('App initialization failed'))
  })
  return bridge
}
