// One App in its double sandbox: an opaque proxy frame that only relays protocol messages, holding the App's own
// opaque frame. The bridge lives as long as the iframe element; placement changes only update the host context, so
// moving the App between display modes never reloads it. An MCP App's document comes from its server; an agent app's
// is assembled here from its launch and goblin's frame bundles (ADR 0021).
import * as Data from 'effect/Data'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  type AppBridge,
  type McpUiDisplayMode,
  type McpUiHostContext,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/client'
import type { AgentAppLaunch } from '@goblin/contracts'
import { Alert, AlertDescription } from '@goblin/ui'
import {
  agentAppHtml,
  appResourceHtml,
  appSandbox,
  isSandboxMessage,
  sandboxHtml,
  sandboxProxy,
} from '../../lib/app-sandbox.ts'
import {
  appCallMutation,
  appDiagnosticMutation,
  appResourceReadMutation,
  appStateQuery,
  appToolCallMutation,
  perform,
} from '../../apps/queries.ts'
import { type AppCalls, createAppBridge } from '../../lib/app-bridge.ts'
import type { StatePush } from '../../lib/agent-app-bridge.ts'
import type { DownloadFile } from '../../lib/app-download.ts'
import type { QuestionAnswerReceipt } from '../../lib/app-message.ts'
import { isString, records } from '../../lib/values.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { type AppPlacement, type Device, hostContext, inlineHeight } from '../../lib/host-context.ts'
import { LinkOffer } from './offers.tsx'
import { browserZone } from '../../lib/format.ts'

/** An MCP App: its server and `ui://` resource, and the call it shows with its result. */
export type McpSelection = {
  readonly kind: 'mcp'
  readonly connectionId: string
  readonly uri: string
  readonly arguments: Record<string, unknown>
  readonly result: CallToolResult
  /** Set when the call did not complete (held, refused, not allowed): the App is told it was cancelled, not given a result. */
  readonly cancelled?: string
}
/** An agent app's view: its App id and its launch (the view's code, styles, bundles and first state). */
export type AgentSelection = { readonly kind: 'agent'; readonly id: string; readonly launch: AgentAppLaunch }
export type AppSelection = McpSelection | AgentSelection

/** Whom an App's offers and asks name: an MCP App's server, or an agent app's name. */
export const selectionOrigin = (selection: AppSelection): string =>
  selection.kind === 'mcp' ? selection.connectionId : selection.launch.name

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
  /** Stage an answer receipt in the host's chrome. True means staged, never submitted. */
  readonly message?: (receipt: QuestionAnswerReceipt) => boolean
}

function device(): Device {
  return {
    dark: document.documentElement.classList.contains('dark'),
    touch: matchMedia('(pointer: coarse)').matches,
    hover: matchMedia('(hover: hover)').matches,
    locale: navigator.language,
    timeZone: browserZone(),
  }
}

/** The host context for `placement`, read from the document's current theme. */
function contextFor(placement: AppPlacement): McpUiHostContext {
  const style = getComputedStyle(document.documentElement)
  return hostContext((name) => style.getPropertyValue(name), device(), placement)
}

/** A failure of this frame's own making, whose words the owner reads as they are. */
class FrameFailure extends Data.TaggedError('FrameFailure')<{ readonly message: string }> {
  constructor(message: string) {
    super({ message })
  }
}

/** Why an App did not load, as the owner reads it: the API's copy of its failures, this frame's words for its own. */
const loadFailure = (cause: unknown): string =>
  cause instanceof FrameFailure ? cause.message : messageOf(cause, 'load the app')

/**
 * The calls an App's frame makes, through the owner's typed client and Query's caches. Remote MCP results are answered
 * whole, as the official SDK validated them on the server (the contract's results are their passthroughs).
 */
function appCalls(queryClient: QueryClient): AppCalls {
  return {
    agent: {
      call: (id, call) => perform(queryClient, appCallMutation, { id, call }),
      state: (id) => queryClient.query(appStateQuery(id)),
      report: async (id, message) => {
        await perform(queryClient, appDiagnosticMutation, { id, message })
      },
    },
    tool: async (connectionId, call) =>
      // SAFETY: the server's tools/call result, validated by the SDK and answered whole (McpToolResult passes it on).
      (await perform(queryClient, appToolCallMutation, { connectionId, call })) as CallToolResult,
    resource: async (connectionId, read) =>
      // SAFETY: the server's resources/read result, validated by the SDK and answered whole (McpResourceResult).
      (await perform(queryClient, appResourceReadMutation, { connectionId, read })) as ReadResourceResult,
  }
}

async function appHtml(selection: AppSelection, calls: AppCalls): Promise<string> {
  if (selection.kind === 'agent') {
    const { frameAssets } = await import('../../lib/app-assets.ts')
    return agentAppHtml(selection.launch.ui, await frameAssets())
  }
  const data = await calls.resource(selection.connectionId, { uri: selection.uri })
  const content = records(data.contents).find(
    (item) =>
      item.uri === selection.uri &&
      (isString(item.text) || isString(item.blob)) &&
      (item.mimeType === 'text/html;profile=mcp-app' || item.mimeType === 'text/html'),
  )
  if (!content) throw new FrameFailure('The server did not provide a supported App HTML resource')
  try {
    return sandboxHtml(appResourceHtml(content), content._meta)
  } catch (error) {
    throw new FrameFailure(error instanceof Error ? error.message : 'The App resource could not be read')
  }
}

async function attachApp(
  element: HTMLIFrameElement,
  selection: AppSelection,
  placement: () => AppPlacement,
  signal: AbortSignal,
  frame: { readonly calls: AppCalls; readonly events: FrameEvents },
): Promise<{ readonly bridge: AppBridge; readonly push?: StatePush } | undefined> {
  const html = await appHtml(selection, frame.calls)
  if (signal.aborted) return undefined
  element.srcdoc = sandboxProxy(window.location.origin)
  const target = element.contentWindow
  if (!target) throw new FrameFailure('App sandbox could not be created')
  const attached = createAppBridge(selection, html, contextFor(placement()), frame.calls, frame.events)
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
      bridge
        .teardownResource({}, { timeout: 500 })
        // expected: an App that does not answer its teardown in time is closed all the same
        .catch(() => undefined)
        .finally(() => {
          theme.disconnect()
          window.removeEventListener('message', gate, true)
          // expected: the frame is going away, so a transport that fails to close leaves nothing to clean up
          bridge.close().catch(() => undefined)
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
  const queryClient = useQueryClient()
  const iframe = useRef<HTMLIFrameElement>(null)
  const bridge = useRef<AppBridge>(undefined)
  const push = useRef<StatePush>(undefined)
  // The bridge outlives renders: what it relays to, where it is placed and which revision it wants are read as they
  // are when it asks, not as they were when it was attached.
  const current = useEffectEvent(() => ({ events, placement, revision }))
  useEffect(() => {
    const controller = new AbortController()
    const element = iframe.current
    const relay: FrameEvents = {
      report: (message) => current().events.report(message),
      resize: (asked) => current().events.resize(asked),
      close: () => current().events.close(),
      requestMode: (mode) => current().events.requestMode(mode),
      share: (shared) => current().events.share(shared),
      offerLink: (link) => current().events.offerLink(link),
      offerDownload: (file) => current().events.offerDownload(file),
      askGrant: (name) => current().events.askGrant(name),
      ...(current().events.message === undefined
        ? {}
        : { message: (receipt: QuestionAnswerReceipt) => current().events.message?.(receipt) ?? false }),
    }
    if (element)
      attachApp(element, selection, () => current().placement, controller.signal, {
        calls: appCalls(queryClient),
        events: relay,
      })
        .then((attached) => {
          bridge.current = attached?.bridge
          push.current = attached?.push
          const wanted = current().revision
          if (wanted !== undefined) push.current?.want(wanted)
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) relay.report(loadFailure(cause))
        })
    return () => {
      bridge.current = undefined
      push.current = undefined
      controller.abort()
    }
  }, [selection, queryClient])
  useEffect(() => {
    if (revision !== undefined) push.current?.want(revision)
  }, [revision])
  const { mode, width, height: room, surface } = placement
  useEffect(() => {
    bridge.current?.setHostContext(contextFor(current().placement))
  }, [mode, width, room, surface])
  return (
    <iframe
      ref={iframe}
      title={selection.kind === 'mcp' ? `MCP App from ${selection.connectionId}` : `App ${selection.launch.name}`}
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
      {link && <LinkOffer link={link} connectionId={selectionOrigin(selection)} onDone={() => setLink(undefined)} />}
      <AppFrame
        height={shown}
        selection={selection}
        placement={{ mode: 'inline', available: ['inline'], width: 720, height: inlineHeight(10_000, viewport) }}
        events={events}
      />
    </div>
  )
}
