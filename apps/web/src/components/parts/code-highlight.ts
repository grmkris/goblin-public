import { useEffect, useSyncExternalStore } from 'react'
import type { PluginConfig } from 'streamdown'

type Highlighter = NonNullable<PluginConfig['code']>

/** Shiki, once the first code block asked for it; loaded once for every message. */
let highlighter: Highlighter | undefined
let requested = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function load() {
  // Never on the server: Shiki and its grammars stay out of the Worker, and the first paint is plain code.
  if (requested || import.meta.env.SSR) return
  requested = true
  import('@streamdown/code')
    .then(({ createCodePlugin }) => {
      highlighter = createCodePlugin({ themes: ['github-light', 'github-dark'] })
      for (const listener of listeners) listener()
    })
    .catch(() => {
      // expected: a chunk that fails to load leaves the code plain, which is still the whole code
      requested = false
    })
}

/**
 * Syntax highlighting for code blocks, loaded the first time a reply shows one: until then code shows plain, and the
 * chat route's first load carries none of it.
 */
export function useCodeHighlighter(): Highlighter | undefined {
  useEffect(load, [])
  return useSyncExternalStore(
    subscribe,
    () => highlighter,
    () => undefined,
  )
}
