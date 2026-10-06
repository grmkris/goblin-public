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
  void connected().then(() => applyTheme(app.getHostContext()))
}

scope.__goblinStart = async (load) => {
  window.addEventListener('error', (event) => report(`${event.message} (${event.filename}:${String(event.lineno)})`))
  window.addEventListener('unhandledrejection', (event) => report(`Unhandled: ${String(event.reason)}`))
  followTheme()
  await firstState()
  const View = load()
  const root = document.getElementById('root')
  if (typeof View !== 'function' || root === null) {
    report('view.tsx must export default a React component.')
    return
  }
  // SAFETY: a function default export of the view module is its component.
  const component = View as React.ComponentType
  ReactDOMClient.createRoot(root).render(React.createElement(ErrorBoundary, null, React.createElement(component)))
}
