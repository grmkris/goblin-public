import { useEffect, useState } from 'react'
import { record, request } from './boundary.ts'

export type SessionState = 'checking' | 'signed-in' | 'signed-out'

/** Whether the owner is signed in, from Better Auth's session endpoint. */
export function useOwnerSession(): readonly [SessionState, (state: SessionState) => void] {
  const [state, setState] = useState<SessionState>('checking')
  useEffect(() => {
    const controller = new AbortController()
    void request('/api/auth/get-session', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState(record(record(data)?.user) ? 'signed-in' : 'signed-out')
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('signed-out')
      })
    return () => controller.abort()
  }, [])
  return [state, setState]
}
