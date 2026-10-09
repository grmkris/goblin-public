// The frame runtime every agent app view loads first (`core.js`): one React for every bundle, the module registry the
// view's code requires from, goblin's components, and the start that waits for the first state before rendering.
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import { applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps'
import * as components from './components.ts'
import { frameRequire, provide } from './modules.ts'
import {
  ErrorBoundary,
  connect,
  connected,
  download,
  firstState,
  report,
  share,
  useActions,
  useAppState,
  useHost,
} from './sdk.ts'

// SAFETY: the frame's globals the inline start script and the bundles share; nothing else defines them.
const scope = globalThis as typeof globalThis & {
  __goblinRequire?: (name: string) => unknown
  __goblinStart?: (load: () => unknown) => Promise<void>
  /** Errors kept by the frame's first script until the start reports them (`app-sandbox.ts`). */
  __goblinEarly?: string[] | null
}
provide({
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  '@goblin/app': { useAppState, useActions, useHost, download, share },
  '@goblin/ui': components,
})
scope.__goblinRequire = frameRequire

function applyTheme(context: McpUiHostContext | undefined): void {
  document.documentElement.classList.toggle('dark', context?.theme === 'dark')
  const variables = context?.styles?.variables
  if (variables === undefined) return
  applyHostStyleVariables(variables)
  const root = document.documentElement.style
  root.setProperty('--background', variables['--color-background-primary'] ?? '')
  root.setProperty('--card', variables['--color-background-secondary'] ?? '')
}

/** Follows the host's theme: goblin's tokens switch under `.dark`. */
function followTheme(): void {
  const app = connect()
  app.addEventListener('hostcontextchanged', () => applyTheme(app.getHostContext()))
  connected()
    .then(() => applyTheme(app.getHostContext()))
    .catch((cause: unknown) => report(`The host's theme could not be applied: ${String(cause)}`))
}

/** The view module's component, or one that throws what loading it threw, so the boundary shows and reports it. */
function viewOf(load: () => unknown): React.ComponentType | string {
  let View: unknown
  try {
    View = load()
  } catch (cause) {
    return function FailedView(): never {
      throw cause
    }
  }
  // SAFETY: a function default export of the view module is its component.
  return typeof View === 'function' ? (View as React.ComponentType) : 'view.tsx must export default a React component.'
}

scope.__goblinStart = async (load) => {
  const early = scope.__goblinEarly ?? []
  scope.__goblinEarly = null
  for (const message of early) report(message)
  window.addEventListener('error', (event) => report(`${event.message} (${event.filename}:${String(event.lineno)})`))
  window.addEventListener('unhandledrejection', (event) => report(`Unhandled: ${String(event.reason)}`))
  followTheme()
  await firstState()
  const view = viewOf(load)
  const root = document.getElementById('root')
  if (typeof view === 'string' || root === null) {
    report(typeof view === 'string' ? view : 'The view has no root element.')
    return
  }
  ReactDOMClient.createRoot(root).render(React.createElement(ErrorBoundary, null, React.createElement(view)))
}
