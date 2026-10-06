// An agent app's view rendered once when it is built, in a Dynamic Worker of its own (ADR 0021): with the state its
// release starts with, so a view that throws while rendering fails its build instead of replacing a working one. The
// view is the CommonJS module `view.js` of this worker; each module it imports is a shim that reads
// `__goblinModules`, filled here before the view loads. React and goblin's components render for real; charts, maps,
// diagrams and icons are stand-ins; the DOM-free mdxcn components and parser render for real.
import { WorkerEntrypoint } from 'cloudflare:workers'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToString } from 'react-dom/server'
import * as mdxcn from '@goblin/kit/mdxcn'
import * as components from './ui/components.ts'
import { VIEW_IMPORTS } from './view-imports.ts'

/** What the check found: it rendered, it threw (and where in view.tsx), or it reads what only a browser has. */
export type Rendered =
  | { readonly outcome: 'rendered' }
  | { readonly outcome: 'threw'; readonly error: string; readonly line?: number }
  | { readonly outcome: 'unchecked'; readonly global: string }

/** Libraries that need browser APIs, unlike the DOM-free mdxcn data figures. */
const INERT = Object.keys(VIEW_IMPORTS).filter((name) => VIEW_IMPORTS[name] !== null && name !== '@goblin/kit/mdxcn')

/**
 * Globals only a browser has. A view that reads one while rendering cannot be rendered here, which says nothing about
 * its code, so the check reports it as unchecked rather than as a throw.
 */
const BROWSER_ONLY = new Set([
  'window',
  'document',
  'location',
  'history',
  'screen',
  'innerWidth',
  'innerHeight',
  'devicePixelRatio',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'matchMedia',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'IntersectionObserver',
  'MutationObserver',
  'HTMLElement',
  'Element',
  'Node',
  'Image',
  'DOMParser',
  'alert',
  'confirm',
  'prompt',
])

/** A stand-in component: renders nothing, and `new` works on it too. */
function nothing(): null {
  return null
}

const empty = () => [].values()

const noPrimitive = () => ''

/**
 * A stand-in module or value: `real` members as they are; any other capitalised member is a component that renders
 * nothing, and anything else takes any use (call, `new`, members, iteration, text).
 */
function inert(real: Readonly<Record<string, unknown>> = {}): object {
  return new Proxy(function () {}, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return noPrimitive
      if (key === Symbol.iterator) return empty
      if (typeof key !== 'string' || key === 'then') return undefined
      if (key === '__esModule') return true
      if (Object.hasOwn(real, key)) return real[key]
      return /^[A-Z]/u.test(key) ? nothing : inert()
    },
    apply: () => inert(),
    construct: () => inert(),
  })
}

/** `@goblin/app` as a view sees it here: the state, actions that do nothing, and stand-ins for the rest. */
const sdk = (state: unknown) =>
  inert({
    useAppState: () => [state, { revision: 0, release: '' }],
    useHost: () => ({ surface: 'inline', width: 640, height: 440 }),
    useActions: () => ({ act: async () => state, pending: false, error: null }),
    download: async () => undefined,
    share: async () => undefined,
    report: () => undefined,
    ErrorBoundary: ({ children }: { readonly children?: React.ReactNode }) => children,
  })

/** The browser global a view read that this check does not have, if that is what it threw. */
function browserGlobal(cause: unknown): string | undefined {
  if (!(cause instanceof ReferenceError)) return undefined
  const name = /^(\w+) is not defined$/u.exec(cause.message)?.[1]
  return name !== undefined && BROWSER_ONLY.has(name) ? name : undefined
}

/** What the view threw, as the check reports it: unchecked for a browser global, or the message and its view.tsx line. */
function described(cause: unknown): Rendered {
  const global = browserGlobal(cause)
  if (global !== undefined) return { outcome: 'unchecked', global }
  const error = cause instanceof Error ? cause.message : String(cause)
  // `view.tsx` keeps its line numbers in `view.js`.
  const line = /view\.js:(\d+)/u.exec(cause instanceof Error ? (cause.stack ?? '') : '')?.[1]
  return line === undefined ? { outcome: 'threw', error } : { outcome: 'threw', error, line: Number(line) }
}

export class Render extends WorkerEntrypoint {
  /** Renders the view once with `state` (JSON text). */
  async render(state: string): Promise<Rendered> {
    Object.assign(globalThis, {
      __goblinModules: {
        react: React,
        'react/jsx-runtime': jsxRuntime,
        '@goblin/ui': components,
        '@goblin/app': sdk(JSON.parse(state)),
        '@goblin/kit/mdxcn': mdxcn,
        ...Object.fromEntries(INERT.map((name) => [name, inert()])),
      },
    })
    try {
      const loaded = await import('./view.js')
      const module = loaded.default
      const view = typeof module === 'object' && module !== null && 'default' in module ? module.default : module
      if (typeof view !== 'function')
        return { outcome: 'threw', error: 'view.tsx must export default a React component.' }
      // SAFETY: a function default export of the view module is its component.
      renderToString(React.createElement(view as React.ComponentType))
      return { outcome: 'rendered' }
    } catch (cause) {
      return described(cause)
    }
  }
}

export default {}
