import { useEffect, useSyncExternalStore } from 'react'

/**
 * A Streamdown plugin loaded the first time a reply needs it, once for every message: until then, and on the server,
 * the reply renders without it. `load` returns nothing on the server; written as `import.meta.env.SSR ? undefined :
 * import(…)` at its call site, the import is dropped from the Worker's build. A load that fails leaves the reply as it
 * was and may be tried again.
 */
export function lazyPlugin<T>(load: () => Promise<T> | undefined) {
  let value: T | undefined
  let requested = false
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const start = () => {
    if (requested) return
    const loading = load()
    if (loading === undefined) return
    requested = true
    loading.then(
      (loaded) => {
        value = loaded
        for (const listener of listeners) listener()
      },
      () => {
        // expected: a chunk that fails to load leaves the reply without the plugin, which still shows its text
        requested = false
      },
    )
  }
  /** The plugin once loaded; `wanted` starts loading it. */
  return function usePlugin(wanted: boolean): T | undefined {
    useEffect(() => {
      if (wanted) start()
    }, [wanted])
    return useSyncExternalStore(
      subscribe,
      () => value,
      () => undefined,
    )
  }
}
