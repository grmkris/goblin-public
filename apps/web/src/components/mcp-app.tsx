import { useEffect, useRef, useState } from 'react'
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client'
import { Alert, AlertDescription } from '@purrable/ui'
import { isSandboxMessage, sandboxHtml, sandboxProxy } from '../lib/app-sandbox.ts'
import { isString, record, records, request, text } from '../lib/boundary.ts'

export type AppSelection = {
  readonly serverId: string
  readonly uri: string
  readonly arguments: Record<string, unknown>
  readonly result: CallToolResult
}
function configuredBridge(
  selection: AppSelection,
  html: string,
  signal: AbortSignal,
  report: (message: string) => void,
): AppBridge {
  const bridge = new AppBridge(null, { name: 'Purrable', version: '0.1.0' }, { serverTools: {}, serverResources: {} })
  bridge.oncalltool = async (params): Promise<CallToolResult> => {
    const response = await request(`/api/mcp/${encodeURIComponent(selection.serverId)}/tools/call`, {
      body: { name: params.name, arguments: params.arguments ?? {} },
      signal,
      headers: { 'x-mcp-caller': 'app' },
    })
    // SAFETY: The authenticated server endpoint returns SDK-validated CallToolResult and enforces the originating server grant.
    return response as CallToolResult
  }
  bridge.onreadresource = async (params): Promise<ReadResourceResult> => {
    const response = await request(`/api/mcp/${encodeURIComponent(selection.serverId)}/resources/read`, {
      body: { uri: params.uri },
      signal,
      headers: { 'x-mcp-caller': 'app' },
    })
    // SAFETY: The authenticated originating server endpoint returns SDK-validated ReadResourceResult.
    return response as ReadResourceResult
  }
  bridge.addEventListener('sandboxready', () => {
    void bridge
      .sendSandboxResourceReady({ html, sandbox: 'allow-scripts' })
      .catch(() => report('App resource could not be loaded'))
  })
  bridge.addEventListener('initialized', () => {
    void bridge
      .sendToolInput({ arguments: selection.arguments })
      .then(() => bridge.sendToolResult(selection.result))
      .catch(() => report('App initialization failed'))
  })
  return bridge
}
async function attachApp(
  element: HTMLIFrameElement,
  selection: AppSelection,
  signal: AbortSignal,
  report: (message: string) => void,
): Promise<void> {
  const data = await request(`/api/mcp/${encodeURIComponent(selection.serverId)}/resources/read`, {
    body: { uri: selection.uri },
    signal,
    headers: { 'x-mcp-caller': 'app' },
  })
  if (signal.aborted) return
  const content = records(record(data)?.contents).find(
    (item) =>
      item.uri === selection.uri &&
      isString(item.text) &&
      (item.mimeType === 'text/html;profile=mcp-app' || item.mimeType === 'text/html'),
  )
  if (!content || !isString(content.text)) throw new Error('The server did not provide a supported App HTML resource')
  element.srcdoc = sandboxProxy(window.location.origin)
  const target = element.contentWindow
  if (!target) throw new Error('App sandbox could not be created')
  const bridge = configuredBridge(selection, sandboxHtml(text(content.text), content._meta), signal, report)
  const gate = (event: MessageEvent): void => {
    if (event.source === target && !isSandboxMessage(event, target)) event.stopImmediatePropagation()
  }
  window.addEventListener('message', gate, true)
  signal.addEventListener(
    'abort',
    () => {
      void bridge
        .teardownResource({}, { timeout: 500 })
        .catch(() => undefined)
        .finally(() => {
          window.removeEventListener('message', gate, true)
          void bridge.close()
        })
    },
    { once: true },
  )
  await bridge.connect(new PostMessageTransport(target, target))
}
export function McpApp({ selection }: { readonly selection: AppSelection }) {
  const iframe = useRef<HTMLIFrameElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    const element = iframe.current
    if (element)
      void attachApp(element, selection, controller.signal, setError).catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'App could not be loaded')
      })
    return () => controller.abort()
  }, [selection])
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}. The ordinary tool result remains available.</AlertDescription>
        </Alert>
      )}
      <iframe
        ref={iframe}
        title={`MCP App from ${selection.serverId}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="mcp-app-frame"
        srcDoc=""
      />
    </div>
  )
}
