import '@danfessler/trellis/style.css'
import { createWorkspace, createDocument, layout, type WorkspaceHandle, type ViewHandle } from '@danfessler/trellis'
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useHydrated } from '@tanstack/react-router'
import type { ThreadView } from '@purrable/contracts'
import type { Pane } from '../lib/workspace-panes.ts'
import { balanceAround, evenDocument, PANEL_TYPE } from '../lib/trellis-layout.ts'
import { parseWorkspaceDocument, pruneDocument } from '../lib/workspace-document.ts'
import { rootParts, threadTitle } from '../lib/threads.ts'
import type { Part } from '../lib/parts.ts'
import { MainThreadPanel, ThreadPane, type ThreadPanelControl } from './thread-panel.tsx'
import { useWorkspace } from './workspace-state.tsx'
import { useThreads } from './threads.tsx'
import { useApps } from './apps/provider.tsx'
import { WorkspaceAppSlot } from './apps/slot.tsx'

const MAIN_TYPE = 'purrable-main'
const TOKENS = {
  '--trellis-bg': 'var(--muted)',
  '--trellis-panel': 'var(--background)',
  '--trellis-text': 'var(--foreground)',
  '--trellis-text-muted': 'var(--muted-foreground)',
  '--trellis-border': 'var(--border)',
  '--trellis-accent': 'var(--ring)',
  '--trellis-accent-contrast': 'var(--background)',
  '--trellis-menu': 'var(--popover)',
  '--trellis-font': 'inherit',
  '--trellis-font-size': '13px',
  '--trellis-gap': '4px',
  '--trellis-radius': 'var(--radius)',
}

function initialDocument(panes: readonly Pane[], views: readonly ThreadView[] = []) {
  const main = layout.stage(layout.view(MAIN_TYPE, { id: 'main', title: 'Main' }))
  const sides = panes
    .filter((pane) => pane.kind !== 'main')
    .map((pane) => layout.view(PANEL_TYPE, { id: pane.id, title: paneTitle(pane, views) }))
  return createDocument(sides.length === 0 ? main : layout.row([main, ...sides]), { version: 1 })
}

/** Stable React hosts, following MyPlan's adapter. No MCP iframe is reparented with these hosts. */
function place(host: HTMLElement, parent: HTMLElement): void {
  if (host.parentElement === parent) return
  const focus =
    document.activeElement instanceof HTMLElement && host.contains(document.activeElement)
      ? document.activeElement
      : undefined
  const target: HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void } = parent
  try {
    if (target.moveBefore && host.isConnected && parent.isConnected) target.moveBefore(host, null)
    else parent.appendChild(host)
  } catch {
    parent.appendChild(host)
  }
  focus?.focus({ preventScroll: true })
}

type Props = {
  readonly children: ReactNode
  readonly panel: ThreadPanelControl | undefined
  readonly parts: readonly Part[]
}
type Live = {
  readonly control: ReturnType<typeof useWorkspace>
  readonly views: readonly ThreadView[]
  readonly apps: ReturnType<typeof useApps>
}
type Resources = {
  readonly root: RefObject<HTMLDivElement | null>
  readonly phone: RefObject<HTMLDivElement | null>
  readonly parking: RefObject<HTMLDivElement | null>
  readonly handle: RefObject<WorkspaceHandle | null>
  readonly hosts: RefObject<Map<string, HTMLDivElement>>
}
function paneTitle(pane: Pane, views: readonly ThreadView[]): string {
  if (pane.kind === 'main') return 'Main'
  if (pane.kind === 'thread') return threadTitle(views.find((view) => view.id === pane.thread))
  return pane.kind === 'app' ? `App · ${pane.serverId}` : 'New thread'
}
function PaneContents({
  pane,
  parts,
  children,
}: {
  readonly pane: Pane
  readonly parts: readonly Part[]
  readonly children: ReactNode
}) {
  const { close, started } = useWorkspace()
  if (pane.kind === 'main') return children
  if (pane.kind === 'app') return <WorkspaceAppSlot />
  const target =
    pane.kind === 'thread'
      ? { kind: 'thread' as const, thread: pane.thread }
      : {
          kind: 'draft' as const,
          ...(pane.entry === undefined ? {} : { entry: pane.entry }),
          root: pane.entry === undefined ? [] : rootParts(parts, pane.entry),
        }
  return (
    <ThreadPane
      host="workspace"
      target={target}
      onClose={() => close(pane.id)}
      onStarted={(id) => started(pane.id, id)}
    />
  )
}

function useResources(panes: readonly Pane[]): Resources {
  const root = useRef<HTMLDivElement>(null)
  const phone = useRef<HTMLDivElement>(null)
  const parking = useRef<HTMLDivElement>(null)
  const handle = useRef<WorkspaceHandle | null>(null)
  const hosts = useRef(new Map<string, HTMLDivElement>())
  for (const pane of panes)
    if (!hosts.current.has(pane.id)) {
      const host = document.createElement('div')
      host.className = 'workspace-pane-host'
      host.dataset.workspacePane = pane.id
      hosts.current.set(pane.id, host)
    }
  useEffect(() => {
    const wanted = new Set(panes.map((pane) => pane.id))
    for (const [id, host] of hosts.current)
      if (!wanted.has(id)) {
        host.remove()
        hosts.current.delete(id)
      }
  }, [panes])
  return useMemo(() => ({ root, phone, parking, handle, hosts }), [])
}

function storedDocument(key: string | undefined, panes: readonly Pane[]) {
  try {
    const saved = key === undefined ? undefined : parseWorkspaceDocument(localStorage.getItem(key))
    return saved === undefined ? initialDocument(panes) : pruneDocument(saved, new Set(panes.map((pane) => pane.id)))
  } catch {
    return initialDocument(panes)
  }
}
function mountHost(resources: Resources, latest: RefObject<Live>, element: HTMLElement, view: ViewHandle) {
  const host = resources.hosts.current.get(view.id)
  if (host === undefined) return
  place(host, element)
  const update = () => {
    host.dataset.workspaceVisible = String(view.visible)
    host.dataset.workspacePanel = view.panelId
    latest.current.apps.kick()
  }
  const off = view.subscribe(update)
  update()
  return () => {
    off()
    if (resources.parking.current) place(host, resources.parking.current)
  }
}
function connectWorkspace(workspace: WorkspaceHandle, latest: RefObject<Live>, key: string | undefined): () => void {
  const persist = () => {
    if (key === undefined) return
    try {
      localStorage.setItem(key, JSON.stringify({ ...workspace.getDocument(), version: 1 }))
    } catch {
      /* Optional device layout. */
    }
  }
  const offChange = workspace.on('change', persist)
  const offFocus = workspace.on('focus', (id) => {
    if (id !== null) latest.current.control.focus(id)
  })
  const offClose = workspace.on('close', (view) => latest.current.control.close(view.id))
  const offSnapshot = workspace.subscribe(() => latest.current.apps.kick())
  const offCamera = workspace.on('camera', () => latest.current.apps.kick())
  const theme = new MutationObserver(() =>
    workspace.update({ theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light' }),
  )
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  const geometry = new MutationObserver(() => latest.current.apps.kick())
  geometry.observe(workspace.element, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
  return () => {
    persist()
    offChange()
    offFocus()
    offClose()
    offSnapshot()
    offCamera()
    theme.disconnect()
    geometry.disconnect()
    workspace.destroy()
  }
}
function mountWorkspace(root: HTMLElement, resources: Resources, latest: RefObject<Live>, key: string | undefined) {
  return createWorkspace(root, {
    types: {
      [MAIN_TYPE]: {
        singleton: true,
        closable: false,
        placement: 'stage',
        allow: { stage: true, side: false, floating: false },
        tabbar: 'never',
        scaling: false,
        mount: (element, view) => mountHost(resources, latest, element, view),
      },
      [PANEL_TYPE]: {
        tabbar: 'always',
        scaling: false,
        allow: { stage: false, side: true, floating: true },
        minSize: { width: 300, height: 240 },
        gestures: 'exclusive',
        mount: (element, view) => mountHost(resources, latest, element, view),
      },
    },
    document: storedDocument(key, latest.current.control.state.panes),
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    tokens: TOKENS,
    floating: 'overlay',
    navigation: 'focus',
    onMissingType: () => 'drop',
    label: 'Purrable workspace',
    panelMenu: (menu) => menu.filter((item) => item === 'separator' || item.id !== 'hide'),
  })
}
function syncPane(workspace: WorkspaceHandle, pane: Pane, views: readonly ThreadView[]) {
  const title = paneTitle(pane, views)
  if (workspace.view(pane.id) !== null) return workspace.setTitle(pane.id, title)
  const opened = workspace.open(pane.kind === 'main' ? MAIN_TYPE : PANEL_TYPE, {
    id: pane.id,
    title,
    placement: pane.kind === 'main' ? 'stage' : 'side',
    focus: false,
  })
  workspace.setDocument(balanceAround(workspace.getDocument(), opened.panelId), { animate: false })
}
function reconcileWorkspace(resources: Resources, live: Live) {
  const workspace = resources.handle.current
  if (!live.control.wide || workspace === null) {
    const main = resources.hosts.current.get('main')
    if (main && resources.phone.current) place(main, resources.phone.current)
    return
  }
  if (workspace.getSnapshot().dragging) return
  const wanted = new Set(live.control.state.panes.map((pane) => pane.id))
  for (const view of workspace.views()) if (!wanted.has(view.id)) void workspace.close(view.id, { force: true })
  for (const pane of live.control.state.panes) syncPane(workspace, pane, live.views)
  if (workspace.getSnapshot().focusedView !== live.control.state.focused) workspace.focus(live.control.state.focused)
  live.apps.kick()
}
function useTrellis(resources: Resources, live: Live) {
  const latest = useRef(live)
  latest.current = live
  const { wide, storageKey, resetVersion } = live.control
  const key = storageKey === undefined ? undefined : `${storageKey}:layout`
  useLayoutEffect(() => {
    if (!wide || resources.root.current === null) return
    const workspace = mountWorkspace(resources.root.current, resources, latest, key)
    resources.handle.current = workspace
    const disconnect = connectWorkspace(workspace, latest, key)
    return () => {
      disconnect()
      resources.handle.current = null
    }
  }, [wide, key, resources])
  useLayoutEffect(() => reconcileWorkspace(resources, live), [live.control.state, wide, live.views, resources])
  useEffect(() => {
    if (resetVersion === 0 || resources.handle.current === null) return
    resources.handle.current.setDocument(
      evenDocument(initialDocument(latest.current.control.state.panes, latest.current.views)),
      { animate: false },
    )
    latest.current.apps.kick()
  }, [resetVersion, resources])
}
function WorkspaceToolbar() {
  const control = useWorkspace()
  return (
    <div className="workspace-toolbar">
      <button type="button" onClick={control.reset}>
        Reset layout
      </button>
      <a href="https://github.com/DanFessler/trellis" target="_blank" rel="noreferrer">
        Workspace layout powered by Trellis by Dan Fessler
      </a>
    </div>
  )
}
function MountedWorkspace({ children, panel, parts }: Props) {
  const control = useWorkspace()
  const { views } = useThreads()
  const apps = useApps()
  const resources = useResources(control.state.panes)
  useTrellis(resources, { control, views, apps })
  return (
    <div className="workspace-layout" data-workspace-layout={control.wide ? 'desktop' : 'narrow'}>
      {control.wide && <WorkspaceToolbar />}
      <div className="workspace-surface" ref={apps.slot('workspace-fullscreen')}>
        <div className="workspace-parking" ref={resources.parking} inert aria-hidden />
        {control.wide ? (
          <div className="workspace-trellis" ref={resources.root} data-testid="trellis" />
        ) : (
          <div className="workspace-phone" ref={resources.phone} />
        )}
        {control.state.panes
          .filter((pane) => control.wide || pane.kind === 'main')
          .map((pane) => {
            const host = resources.hosts.current.get(pane.id)
            return host === undefined
              ? null
              : createPortal(
                  <PaneContents pane={pane} parts={parts}>
                    {children}
                  </PaneContents>,
                  host,
                  pane.id,
                )
          })}
        {!control.wide && <MainThreadPanel panel={panel} parts={parts} />}
      </div>
    </div>
  )
}

/** Trellis is DOM-only: server and hydration render main alone. */
export function WorkspaceLayout(props: Props) {
  const hydrated = useHydrated()
  return hydrated ? <MountedWorkspace {...props} /> : props.children
}
