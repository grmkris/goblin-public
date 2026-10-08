import { useEffect, useState } from 'react'
import { viewportKeyboardInset } from '../lib/keyboard.ts'

/** Observes viewport and focus together, including keyboard dismissal without a blur. */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      const editable = document.activeElement?.matches('input, textarea, select, [contenteditable="true"]') ?? false
      setInset(viewportKeyboardInset(viewport, window.innerHeight, editable))
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('focusin', update)
    window.addEventListener('focusout', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('focusin', update)
      window.removeEventListener('focusout', update)
    }
  }, [])
  return inset
}
