import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useHydrated } from '@tanstack/react-router'
import { useMediaQuery } from '@purrable/ui'
import {
  appPane,
  closePane,
  draftPane,
  initialPanes,
  openPane,
  parsePanes,
  reconcilePanes,
  syncAppPane,
  threadPane,
  workspaceStorageKey,
  type Pane,
  type PaneState,
} from '../lib/workspace-panes.ts'
import { record, request } from '../lib/boundary.ts'
import { useApps } from './apps/provider.tsx'
import type { ThreadPanelControl } from './thread-panel.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

const WIDE = '(min-width: 75rem)'
type WorkspaceState = {
  readonly wide: boolean
  readonly state: PaneState
  readonly storageKey: string | undefined
  readonly openThread: (id: string) => void
  readonly started: (draft: string, id: string) => void
  readonly close: (id: string) => void
  readonly focus: (id: string) => void
  readonly reset: () => void
  readonly resetVersion: number
}
const WorkspaceContext = createContext<WorkspaceState | undefined>(undefined)
export function useWorkspace(): WorkspaceState {
  const value = use(WorkspaceContext)
  if (value === undefined) throw new Error('useWorkspace outside WorkspaceProvider')
  return value
}

function useDeviceState(primary: string) {
  const [state, setState] = useState(initialPanes)
  const [key, setKey] = useState<string>()
  const { conversations: views } = useWorkspaceFeed()
  useEffect(() => {
    const controller = new AbortController()
    void request('/api/auth/get-session', { signal: controller.signal })
      .then((data) => {
        const id = record(record(data)?.user)?.id
        if (typeof id !== 'string' || controller.signal.aborted) return
        const storageKey = workspaceStorageKey(id, primary)
        try {
          const stored = parsePanes(localStorage.getItem(storageKey))
          setState((current) => ({
            ...stored,
            focused: current.focused === 'main' ? stored.focused : current.focused,
            panes: [
              ...stored.panes,
              ...current.panes.filter((pane) => !stored.panes.some((item) => item.id === pane.id)),
            ],
          }))
        } catch {
          // Device persistence is optional.
        }
        setKey(storageKey)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [primary])
  useEffect(() => {
    if (key === undefined || !views.some((view) => view.kind === 'main')) return
    try {
      localStorage.setItem(key, JSON.stringify({ version: 1, ...state }))
    } catch {
      /* Optional device arrangement. */
    }
  }, [key, state, views])
  return { state, setState, key }
}

function paneFromControl(panel: ThreadPanelControl | undefined): Pane | undefined {
  if (panel?.thread !== undefined) return threadPane(panel.thread)
  if (panel?.draft !== undefined) return draftPane(panel.draft)
  return panel?.fresh ? draftPane() : undefined
}

/** The URL names the last opened thread; earlier panes and their stable hosts survive it. */
export function WorkspaceProvider({
  primary,
  panel,
  children,
}: {
  readonly primary: string
  readonly panel: ThreadPanelControl | undefined
  readonly children: ReactNode
}) {
  const hydrated = useHydrated()
  const wide = useMediaQuery(WIDE) && hydrated
  const { state, setState, key } = useDeviceState(primary)
  const { conversations: views } = useWorkspaceFeed()
  const { session, close: closeApp } = useApps()
  const currentApp = useMemo(
    () => (session === undefined ? undefined : appPane(session.selection.serverId, session.key)),
    [session?.key, session?.selection.serverId],
  )
  const routePane = paneFromControl(panel)
  const previous = useRef<Pane | undefined>(undefined)
  const [resetVersion, setResetVersion] = useState(0)
  useEffect(() => {
    const before = previous.current
    previous.current = routePane
    setState((current) => {
      const next =
        before?.kind === 'draft' || (before !== undefined && routePane === undefined)
          ? closePane(current, before.id)
          : current
      return routePane === undefined ? next : openPane(next, routePane)
    })
  }, [routePane?.id, setState])
  useEffect(() => {
    setState((current) => {
      const next = views.some((view) => view.kind === 'main') ? reconcilePanes(current, views, currentApp) : current
      return syncAppPane(next, currentApp)
    })
  }, [views, currentApp, key, setState])
  const openThread = useCallback(
    (id: string) => {
      setState((current) => openPane(current, threadPane(id)))
      panel?.open(id)
    },
    [panel?.open, setState],
  )
  const started = useCallback(
    (draft: string, id: string) => {
      setState((current) => openPane(closePane(current, draft), threadPane(id)))
      panel?.open(id)
    },
    [panel?.open, setState],
  )
  const close = useCallback(
    (id: string) => {
      if (id === 'main') return
      setState((current) => closePane(current, id))
      if (id === currentApp?.id) closeApp()
      if (id === routePane?.id) panel?.close()
    },
    [currentApp?.id, routePane?.id, closeApp, panel?.close, setState],
  )
  const focus = useCallback(
    (id: string) =>
      setState((current) => {
        const pane = current.panes.find((candidate) => candidate.id === id)
        return pane === undefined ? current : openPane(current, pane)
      }),
    [setState],
  )
  const reset = useCallback(() => {
    setResetVersion((n) => n + 1)
  }, [])
  const value = useMemo(
    () => ({ wide, state, storageKey: key, openThread, started, close, focus, reset, resetVersion }),
    [wide, state, key, openThread, started, close, focus, reset, resetVersion],
  )
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>
}
