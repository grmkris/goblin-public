import { useEffect, useRef, useState } from 'react'
import { AppBridge, type McpUiHostContext, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client'
import { Alert, AlertDescription } from '@purrable/ui'
import { isSandboxMessage, sandboxHtml, sandboxProxy } from '../lib/app-sandbox.ts'
import { isString, record, records, request, text } from '../lib/boundary.ts'
import { availableModes, type Device, hostContext, inlineHeight } from '../lib/host-context.ts'

export type AppSelection = {
  readonly serverId: string
  readonly uri: string
  readonly arguments: Record<string, unknown>
  readonly result: CallToolResult
}
/** What the App's frame reports back to the host: a failure to show, a size it would like, a request to close. */
type FrameEvents = {
  readonly report: (message: string) => void
  readonly resize: (height: number) => void
  readonly close: () => void
}

function device(): Device {
  return {
    dark: document.documentElement.classList.contains('dark'),
    touch: matchMedia('(pointer: coarse)').matches,
    hover: matchMedia('(hover: hover)').matches,
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

/** The host context for an inline App `width` pixels wide, read from the document's current theme. */
function inlineContext(width: number): McpUiHostContext {
  const style = getComputedStyle(document.documentElement)
  const phone = matchMedia('(max-width: 767px)').matches
  return hostContext((name) => style.getPropertyValue(name), device(), {
    mode: 'inline',
    available: availableModes(phone).filter((mode) => mode === 'inline'),
    width,
    height: inlineHeight(Number.POSITIVE_INFINITY, window.innerHeight),
  })
}

function configuredBridge(
  selection: AppSelection,
  html: string,
  context: McpUiHostContext,
  signal: AbortSignal,
  events: FrameEvents,
): AppBridge {
  const bridge = new AppBridge(
    null,
    { name: 'Purrable', version: '0.1.0' },
    { serverTools: {}, serverResources: {} },
    { hostContext: context },
  )
  bridge.addEventListener('sizechange', ({ height }) => {
    if (height !== undefined) events.resize(height)
  })
  bridge.addEventListener('requestteardown', () => events.close())
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
async function attachApp(
  element: HTMLIFrameElement,
  selection: AppSelection,
  signal: AbortSignal,
  events: FrameEvents,
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
  const html = sandboxHtml(text(content.text), content._meta)
  const bridge = configuredBridge(selection, html, inlineContext(element.clientWidth), signal, events)
  // The theme follows the system; tell the App when it switches.
  const theme = new MutationObserver(() => bridge.setHostContext(inlineContext(element.clientWidth)))
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
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
          theme.disconnect()
          window.removeEventListener('message', gate, true)
          void bridge.close()
        })
    },
    { once: true },
  )
  await bridge.connect(new PostMessageTransport(target, target))
}
export function McpApp({ selection, onClose }: { readonly selection: AppSelection; readonly onClose: () => void }) {
  const iframe = useRef<HTMLIFrameElement>(null)
  const [error, setError] = useState('')
  const [height, setHeight] = useState<number>()
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    const element = iframe.current
    const events: FrameEvents = { report: setError, resize: setHeight, close: onClose }
    if (element)
      void attachApp(element, selection, controller.signal, events).catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'App could not be loaded')
      })
    return () => controller.abort()
  }, [selection, onClose])
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
        height={inlineHeight(height, typeof window === 'undefined' ? 900 : window.innerHeight)}
        srcDoc=""
      />
    </div>
  )
}
