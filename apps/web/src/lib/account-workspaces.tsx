import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Schema } from 'effect'
import { WorkspaceState } from '@purrable/contracts'
import { failureText, request } from './boundary.ts'
import { useSession } from './session.tsx'
import { setWorkspaceContext } from './workspace-request.ts'

interface AccountWorkspaces {
  readonly state: WorkspaceState | undefined
  readonly error: string
  readonly refresh: () => Promise<void>
  readonly select: (workspaceId: string) => Promise<void>
}
const Context = createContext<AccountWorkspaces>({
  state: undefined,
  error: '',
  refresh: async () => undefined,
  select: async () => undefined,
})
const decode = Schema.decodeUnknownSync(WorkspaceState)
export function AccountWorkspacesProvider({ children }: { readonly children: ReactNode }) {
  const [session] = useSession()
  const [state, setState] = useState<WorkspaceState>()
  const [error, setError] = useState('')
  const current = useRef<WorkspaceState | undefined>(undefined)
  const refresh = useCallback(async () => {
    try {
      const next = decode(await request('/api/workspaces'))
      if (current.current !== undefined && current.current.context !== next.context) {
        window.location.reload()
        return
      }
      current.current = next
      setWorkspaceContext(next.context)
      setState(next)
      setError('')
    } catch (cause) {
      setError(failureText(cause))
    }
  }, [])
  const select = useCallback(async (workspaceId: string) => {
    await request('/api/workspaces/active', {
      body: { workspaceId, context: current.current?.context ?? null },
      headers: { 'x-purrable-csrf': '1' },
    })
    // Navigation tears down streams, App frames and all in-memory query/conversation state.
    window.location.assign('/settings')
  }, [])
  useEffect(() => {
    if (session !== 'signed-in') {
      current.current = undefined
      setState(undefined)
      setWorkspaceContext(null)
      return
    }
    void refresh()
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [session, refresh])
  return <Context value={{ state, error, refresh, select }}>{children}</Context>
}
export const useAccountWorkspaces = (): AccountWorkspaces => useContext(Context)
