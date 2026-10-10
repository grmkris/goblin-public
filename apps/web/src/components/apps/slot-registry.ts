// The places a stage can follow, registered by their slots while mounted, and the kick that tells every stage a place
// moved or resized so it re-measures on its next frame.
import { useCallback, useRef } from 'react'

/** Where a stage can be: an App's place in its transcript, or its page. */
export type SlotName = `app-inline:${string}` | `app-page:${string}`

export function useSlots(kick: () => void) {
  const elements = useRef(new Map<SlotName, HTMLElement>())
  const callbacks = useRef(new Map<SlotName, (element: HTMLElement | null) => void>())
  const slot = useCallback(
    (name: SlotName) => {
      const existing = callbacks.current.get(name)
      if (existing) return existing
      const callback = (element: HTMLElement | null) => {
        if (element) elements.current.set(name, element)
        else elements.current.delete(name)
        kick()
      }
      callbacks.current.set(name, callback)
      return callback
    },
    [kick],
  )
  const element = useCallback((name: SlotName) => elements.current.get(name), [])
  return { slot, element }
}

export function useKicks() {
  const listeners = useRef(new Set<() => void>())
  const kick = useCallback(() => {
    for (const listener of listeners.current) listener()
  }, [])
  const onKick = useCallback((listener: () => void) => {
    listeners.current.add(listener)
    return () => void listeners.current.delete(listener)
  }, [])
  return { kick, onKick }
}
