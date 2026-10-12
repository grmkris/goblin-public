import { AppBridge, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client'
import type { AppSelection, FrameEvents, McpSelection } from '../components/apps/frame.tsx'
import { contextText, safeLink } from './app-context.ts'
import { downloadOf } from './app-download.ts'
import { appSandbox } from './app-sandbox.ts'
import { questionAnswerReceipt } from './app-message.ts'
import { grantDenied } from '../components/apps/grant-ask.tsx'
import { type AgentAppCalls, AppCallFailure, type StatePush, agentBridge } from './agent-app-bridge.ts'
import { messageOf } from './query/app-error.ts'

export type AppCalls = {
  /** An agent app's routes; an MCP App uses `tool` and `resource`. */
  readonly agent: AgentAppCalls
  readonly tool: (
    connectionId: string,
    params: { name: string; arguments: Record<string, unknown> },
  ) => Promise<CallToolResult>
  readonly resource: (connectionId: string, params: { uri: string }) => Promise<ReadResourceResult>
}

const refusal = (cause: unknown, action: string): AppCallFailure => new AppCallFailure(messageOf(cause, action))

/** Hands a newer result of the same call to a live MCP App, once it has initialized; before that, its first one. */
export type ResultDelivery = (result: CallToolResult) => void

/**
 * An MCP App's handlers: its calls and reads go to its own server under the owner's grants, live. Returns how a newer
 * result of the same call reaches the App without reloading it.
 */
function mcpBridge(bridge: AppBridge, selection: McpSelection, calls: AppCalls, events: FrameEvents): ResultDelivery {
  const { connectionId } = selection
  bridge.oncalltool = async (params) => {
    const call = () => calls.tool(connectionId, { name: params.name, arguments: params.arguments ?? {} })
    try {
      return await call()
    } catch (cause) {
      // An ungranted tool waits for the owner instead of failing; allowed, the same call runs once more.
      if (grantDenied(cause) && (await events.askGrant(params.name)))
        return call().catch((again: unknown) => {
          throw refusal(again, `call ${params.name}`)
        })
      throw refusal(cause, `call ${params.name}`)
    }
  }
  bridge.onreadresource = (params) =>
    calls.resource(connectionId, { uri: params.uri }).catch((cause: unknown) => {
      throw refusal(cause, 'read its resource')
    })
  if (events.message !== undefined)
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP AppBridge exposes ui/message as an RPC handler, not an event.
    bridge.onmessage = async ({ content }) => {
      const receipt = questionAnswerReceipt(content)
      return receipt !== undefined && events.message?.(receipt) ? {} : { isError: true }
    }
  let latest = selection.result
  let ready = false
  bridge.addEventListener('initialized', () => {
    void bridge
      .sendToolInput({ arguments: selection.arguments })
      .then(() => {
        ready = true
        return selection.cancelled === undefined
          ? bridge.sendToolResult(latest)
          : bridge.sendToolCancelled({ reason: selection.cancelled })
      })
      .catch(() => events.report('App initialization failed'))
  })
  return (result) => {
    if (result === latest || selection.cancelled !== undefined) return
    latest = result
    if (ready) bridge.sendToolResult(result).catch(() => events.report('The App did not take its newer result'))
  }
}

/**
 * The host side of one App's frame: an MCP App's or an agent app's own handlers, then what every App shares (display
 * modes, links, size, teardown, loading its document). An agent app's bridge also returns what pushes its state, an
 * MCP App's how a newer result reaches it.
 */
export function createAppBridge(
  selection: AppSelection,
  html: string,
  context: McpUiHostContext,
  calls: AppCalls,
  events: FrameEvents,
): { readonly bridge: AppBridge; readonly push?: StatePush; readonly deliver?: ResultDelivery } {
  const bridge = new AppBridge(
    null,
    { name: 'goblin', version: '0.1.0' },
    selection.kind === 'mcp'
      ? {
          serverTools: {},
          serverResources: {},
          openLinks: {},
          downloadFile: {},
          updateModelContext: { text: {}, structuredContent: {} },
          ...(events.message === undefined ? {} : { message: { text: {} } }),
        }
      : { serverTools: {}, openLinks: {}, downloadFile: {}, logging: {}, updateModelContext: { text: {} } },
    { hostContext: context },
  )
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
  bridge.ondownloadfile = async ({ contents }) => {
    const file = downloadOf(contents)
    if (file === undefined) return { isError: true }
    events.offerDownload(file)
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
  if (selection.kind === 'mcp') return { bridge, deliver: mcpBridge(bridge, selection, calls, events) }
  const { launch } = selection
  const first = { revision: launch.revision, release: launch.release, state: launch.state }
  return { bridge, push: agentBridge(bridge, { id: selection.id, first }, calls.agent, events.report) }
}
