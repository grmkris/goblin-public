// The View side of the MCP Apps handshake, shared by both views. Handlers are registered before connect (useApp does
// that), the host context drives theme and insets, and the latest tool input and result are kept as plain state.
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { App, McpUiHostContext } from '@modelcontextprotocol/ext-apps'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import { useEffect, useState } from 'react'
import { applyHostTheme } from './host-theme.ts'

export interface WalletApp {
  readonly app: App | null
  readonly error: Error | null
  readonly context: McpUiHostContext | undefined
  /** The arguments the model passed to the tool that opened this view. */
  readonly input: Record<string, unknown> | undefined
  readonly result: CallToolResult | undefined
  /** The host cancelled the call that this view was waiting on. */
  readonly cancelled: boolean
}

export function useWalletApp(name: string): WalletApp {
  // The SDK merges every context change into `getHostContext()`; the counter only re-renders on it.
  const [, setContextVersion] = useState(0)
  const [input, setInput] = useState<Record<string, unknown> | undefined>()
  const [result, setResult] = useState<CallToolResult | undefined>()
  const [cancelled, setCancelled] = useState(false)
  const { app, isConnected, error } = useApp({
    appInfo: { name, version: '1.0.0' },
    capabilities: {},
    onAppCreated: (created) => {
      created.addEventListener('hostcontextchanged', () => setContextVersion((version) => version + 1))
      created.addEventListener('toolinput', (params) => setInput(params.arguments))
      created.addEventListener('toolresult', (params) => {
        setCancelled(false)
        setResult(params)
      })
      created.addEventListener('toolcancelled', () => setCancelled(true))
      // Nothing to flush on teardown: the view keeps no state of its own, and the host owns the frame.
      created.onteardown = () => Promise.resolve({})
    },
  })
  const context = isConnected ? app?.getHostContext() : undefined
  useEffect(() => {
    applyHostTheme(context)
  }, [context])
  return { app, error, context, input, result, cancelled }
}
