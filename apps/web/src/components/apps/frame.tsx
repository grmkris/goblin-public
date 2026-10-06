// One App in its double sandbox: an opaque proxy frame that only relays protocol messages, holding the App's own
// opaque frame. The bridge lives as long as the iframe element; placement changes only update the host context, so
// moving the App between display modes never reloads it. An MCP App's document comes from its server; an agent app's
// is assembled here from its launch and goblin's frame bundles (ADR 0021).
import { useEffect, useRef, useState } from 'react'
import {
  type AppBridge,
  type McpUiDisplayMode,
  type McpUiHostContext,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client'
import type { AgentAppLaunch } from '@goblin/contracts'
import { Alert, AlertDescription } from '@goblin/ui'
import { agentAppHtml, appSandbox, isSandboxMessage, sandboxHtml, sandboxProxy } from '../../lib/app-sandbox.ts'
import { createAppBridge } from '../../lib/app-bridge.ts'
import { type StatePush, agentAppCalls } from '../../lib/agent-app-bridge.ts'
import type { DownloadFile } from '../../lib/app-download.ts'
import { isString, record, records, request, text } from '../../lib/boundary.ts'
import { type AppPlacement, type Device, hostContext, inlineHeight } from '../../lib/host-context.ts'
import { LinkOffer } from './offers.tsx'

/** An MCP App: its server and `ui://` resource, and the call it shows with its result. */
export type McpSelection = {
  readonly kind: 'mcp'
  readonly serverId: string
  readonly uri: string
  readonly arguments: Record<string, unknown>
  readonly result: CallToolResult
}
/** An agent app's view: its App id and its launch (the view's code, styles, bundles and first state). */
export type AgentSelection = { readonly kind: 'agent'; readonly id: string; readonly launch: AgentAppLaunch }
export type AppSelection = McpSelection | AgentSelection

/** Whom an App's offers and asks name: an MCP App's server, or an agent app's name. */
export const selectionOrigin = (selection: AppSelection): string =>
  selection.kind === 'mcp' ? selection.serverId : selection.launch.name

/** What the App asks of the host: to report a failure, a height, to close, or another display mode. */
export type FrameEvents = {
  readonly report: (message: string) => void
  readonly resize: (height: number) => void
  readonly close: () => void
  /** Returns the mode the App is in afterwards: the requested one if the host offers it. */
  readonly requestMode: (mode: McpUiDisplayMode) => McpUiDisplayMode
  /** What the App shares for the agent; '' withdraws it. */
  readonly share: (text: string) => void
  /** A link the App asks to open: offered to the owner, never opened for them. */
  readonly offerLink: (link: URL) => void
  /** A file the App asks to download: offered to the owner, never saved for them. */
  readonly offerDownload: (file: DownloadFile) => void
  /** The App called a tool the owner has not granted: true once they allow it, false if they do not. */
  readonly askGrant: (name: string) => Promise<boolean>
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

/** The host context for `placement`, read from the document's current theme. */
function contextFor(placement: AppPlacement): McpUiHostContext {
  const style = getComputedStyle(document.documentElement)
  return hostContext((name) => style.getPropertyValue(name), device(), placement)
}

function forward<T>(serverId: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
  // SAFETY: the authenticated endpoints return SDK-validated results and enforce the originating server's grants.
  return request(`/api/mcp/${encodeURIComponent(serverId)}/${path}`, {
    body,
    signal,
    headers: { 'x-mcp-caller': 'app' },
  }) as Promise<T>
}

async function appHtml(selection: AppSelection, signal: AbortSignal): Promise<string> {
  if (selection.kind === 'agent') {
    const { frameAssets } = await import('../../lib/app-assets.ts')
    return agentAppHtml(selection.launch.ui, await frameAssets())
  }
  const data = await forward<unknown>(selection.serverId, 'resources/read', { uri: selection.uri }, signal)
  const content = records(record(data)?.contents).find(
    (item) =>
      item.uri === selection.uri &&
      isString(item.text) &&
      (item.mimeType === 'text/html;profile=mcp-app' || item.mimeType === 'text/html'),
  )
  if (!content || !isString(content.text)) throw new Error('The server did not provide a supported App HTML resource')
  return sandboxHtml(text(content.text), content._meta)
}

async function attachApp(
  element: HTMLIFrameElement,
  selection: AppSelection,
  placement: () => AppPlacement,
  signal: AbortSignal,
  events: FrameEvents,
): Promise<{ readonly bridge: AppBridge; readonly push?: StatePush } | undefined> {
  const html = await appHtml(selection, signal)
  if (signal.aborted) return undefined
  element.srcdoc = sandboxProxy(window.location.origin)
  const target = element.contentWindow
  if (!target) throw new Error('App sandbox could not be created')
  const attached = createAppBridge(
    selection,
    html,
    contextFor(placement()),
    {
      agent: agentAppCalls,
      tool: (serverId, body) => forward<CallToolResult>(serverId, 'tools/call', body, signal),
      resource: (serverId, body) => forward<ReadResourceResult>(serverId, 'resources/read', body, signal),
    },
    events,
  )
  const { bridge } = attached
  // The theme follows the system; tell the App when it switches.
  const theme = new MutationObserver(() => bridge.setHostContext(contextFor(placement())))
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
  return attached
}

/**
 * The App's iframe and bridge. `placement` may change freely; only `selection` (re)loads the App. An agent app's
 * `revision` follows the feed, and a newer one is pushed into the frame.
 */
export function AppFrame({
  selection,
  placement,
  events,
  height,
  revision,
}: {
  readonly selection: AppSelection
  readonly placement: AppPlacement
  readonly events: FrameEvents
  /** A fixed height in pixels for a framed App in a page; without it the frame fills the stage. */
  readonly height?: number
  readonly revision?: number
}) {
  const iframe = useRef<HTMLIFrameElement>(null)
  const bridge = useRef<AppBridge>(undefined)
  const push = useRef<StatePush>(undefined)
  const wanted = useRef(revision)
  wanted.current = revision
  const latest = useRef({ placement, events })
  latest.current = { placement, events }
  useEffect(() => {
    const controller = new AbortController()
    const element = iframe.current
    const relay: FrameEvents = {
      report: (message) => latest.current.events.report(message),
      resize: (asked) => latest.current.events.resize(asked),
      close: () => latest.current.events.close(),
      requestMode: (mode) => latest.current.events.requestMode(mode),
      share: (shared) => latest.current.events.share(shared),
      offerLink: (link) => latest.current.events.offerLink(link),
      offerDownload: (file) => latest.current.events.offerDownload(file),
      askGrant: (name) => latest.current.events.askGrant(name),
    }
    if (element)
      attachApp(element, selection, () => latest.current.placement, controller.signal, relay)
        .then((attached) => {
          bridge.current = attached?.bridge
          push.current = attached?.push
          if (wanted.current !== undefined) push.current?.want(wanted.current)
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            relay.report(cause instanceof Error ? cause.message : 'App could not be loaded')
        })
    return () => {
      bridge.current = undefined
      push.current = undefined
      controller.abort()
    }
  }, [selection])
  useEffect(() => {
    if (revision !== undefined) push.current?.want(revision)
  }, [revision])
  const { mode, width, height: room } = placement
  useEffect(() => {
    bridge.current?.setHostContext(contextFor(latest.current.placement))
  }, [mode, width, room])
  return (
    <iframe
      ref={iframe}
      title={selection.kind === 'mcp' ? `MCP App from ${selection.serverId}` : `App ${selection.launch.name}`}
      sandbox={appSandbox(selection.kind)}
      referrerPolicy="no-referrer"
      className={height === undefined ? 'app-stage-frame' : 'mcp-app-frame'}
      height={height}
      srcDoc=""
    />
  )
}

/** An App shown in place and nowhere else (the tool console): inline only, as tall as it asks. */
export function McpApp({ selection, onClose }: { readonly selection: McpSelection; readonly onClose: () => void }) {
  const [error, setError] = useState('')
  const [height, setHeight] = useState<number>()
  const [link, setLink] = useState<URL>()
  const viewport = typeof window === 'undefined' ? 900 : window.innerHeight
  const shown = inlineHeight(height, viewport)
  const events: FrameEvents = {
    report: setError,
    resize: setHeight,
    close: onClose,
    requestMode: () => 'inline',
    share: () => undefined,
    offerLink: setLink,
    offerDownload: () => undefined,
    askGrant: async () => false,
  }
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}. The ordinary tool result remains available.</AlertDescription>
        </Alert>
      )}
      {link && <LinkOffer link={link} serverId={selectionOrigin(selection)} onDone={() => setLink(undefined)} />}
      <AppFrame
        height={shown}
        selection={selection}
        placement={{ mode: 'inline', available: ['inline'], width: 720, height: inlineHeight(10_000, viewport) }}
        events={events}
      />
    </div>
  )
}
