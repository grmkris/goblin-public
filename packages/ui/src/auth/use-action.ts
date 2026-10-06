// Adapted from grmkris/myapps packages/ui/src/auth (9616f76): the sign-in look Kristjan uses across his apps.
import { useRef, useState } from 'react'
import type { AuthActionResult } from './contract.ts'

export interface ActionState {
  readonly busy: boolean
  readonly error: string | null
  /** Runs `action` once at a time; true when it succeeded. A thrown error shows `fallback`, never its message. */
  readonly run: (action: () => Promise<AuthActionResult>) => Promise<boolean>
  readonly clearError: () => void
}

/** Busy and error state around one app callback at a time. */
export function useAction(fallback: string): ActionState {
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<AuthActionResult>): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (!result.ok) setError(result.error)
      return result.ok
    } catch {
      setError(fallback)
      return false
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return { busy, error, run, clearError: () => setError(null) }
}
