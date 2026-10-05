import { useCallback, useSyncExternalStore } from 'react'

/**
 * Whether `query` matches, live. The server render and hydration answer false (so they agree); a component mounted
 * after that gets the real answer on its first render, so it never draws the wrong layout for a frame.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false,
  )
}

/** The phone layout: below Tailwind's `md` breakpoint (48rem). */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)')
}
