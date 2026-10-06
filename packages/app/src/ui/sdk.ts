// The UI half of the agent app SDK: what an app's view imports as `@goblin/app` inside its sandboxed frame (ADR 0021).
// The host pushes the app's state as tool results whose `_meta['goblin/state']` carries it with its revision; actions
// go back as server tool calls with an operation id, and their results carry the state after them the same way.
import { App } from '@modelcontextprotocol/ext-apps'
import { Component, type ReactNode, createElement, useCallback, useState, useSyncExternalStore } from 'react'

/** The app's state as the frame has it: the newest revision wins, older pushes are ignored. */
export type Snapshot = { readonly revision: number; readonly release: string; readonly state: unknown }

const STATE = 'goblin/state'
let app: App | undefined
let ready: Promise<void> | undefined
let snapshot: Snapshot | undefined
const listeners = new Set<() => void>()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Takes a pushed or returned state when it is newer than the one shown. */
function accept(meta: unknown): void {
  const tag = isRecord(meta) ? meta[STATE] : undefined
  if (!isRecord(tag) || typeof tag.revision !== 'number') return
  if (snapshot !== undefined && tag.revision <= snapshot.revision) return
  snapshot = { revision: tag.revision, release: typeof tag.release === 'string' ? tag.release : '', state: tag.state }
  for (const listener of listeners) listener()
}

/** The frame's connection to the host, made once. */
export function connect(): App {
  if (app !== undefined) return app
  const connection = new App({ name: 'goblin-agent-app', version: '1' }, {})
  connection.addEventListener('toolresult', (result) => accept(result._meta))
  app = connection
  ready = connection.connect()
  return connection
}

/** Resolves once the host answered the frame's handshake (its context is known then). */
export function connected(): Promise<void> {
  connect()
  return ready ?? Promise.resolve()
}

/** Resolves once the host has pushed the first state (the runtime renders the view only then). */
export function firstState(): Promise<void> {
  connect()
  if (snapshot !== undefined) return Promise.resolve()
  return new Promise((resolve) => {
    const arrived = () => {
      listeners.delete(arrived)
      resolve()
    }
    listeners.add(arrived)
  })
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The app's state and its revision, live: every change by the agent, a job or another view arrives here. */
export function useAppState<S = unknown>(): [S, { readonly revision: number; readonly release: string }] {
  const current = useSyncExternalStore(subscribe, () => snapshot)
  // SAFETY: the host checked the state against the app's own state.schema; S is the app's declared shape.
  return [current?.state as S, { revision: current?.revision ?? 0, release: current?.release ?? '' }]
}

/** Calls the app's actions: `act(name, input)` resolves with the new state; `pending` and `error` follow the last. */
export function useActions() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = useCallback(async (name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
    setPending(true)
    setError(null)
    try {
      const result = await connect().callServerTool({
        name,
        arguments: input,
        _meta: { 'goblin/op': `ui:${crypto.randomUUID()}` },
      })
      const text = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
      if (result.isError === true) throw new Error(text === '' ? `${name} failed` : text)
      accept(result._meta)
      return snapshot?.state
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      throw cause
    } finally {
      setPending(false)
    }
  }, [])
  return { act, pending, error }
}

/** Offers the owner a file to save: goblin shows it with a Save button, and nothing is saved without their click. */
export async function download(name: string, text: string, type = 'text/plain'): Promise<void> {
  const resource = { uri: `file:///${encodeURIComponent(name)}`, mimeType: type, text }
  const result = await connect().downloadFile({ contents: [{ type: 'resource', resource }] })
  if (result.isError === true) throw new Error(`${name} could not be offered`)
}

/** Reports a UI failure to the host, which tells the agent (no more than one notice in a while). */
export function report(message: string): void {
  void connect().sendLog({ level: 'error', data: message.slice(0, 2000) })
}

/** Shows what went wrong instead of a blank frame, and reports it. */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly error: string | null }> {
  override state: { readonly error: string | null } = { error: null }
  static getDerivedStateFromError(cause: unknown): { error: string } {
    return { error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) }
  }
  override componentDidCatch(cause: unknown): void {
    report(cause instanceof Error ? `${cause.name}: ${cause.message}\n${cause.stack ?? ''}` : String(cause))
  }
  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return createElement(
      'div',
      { role: 'alert', style: { padding: 16, color: 'var(--destructive)', font: '13px system-ui' } },
      `This app's view failed: ${this.state.error}. Your agent was told.`,
    )
  }
}
