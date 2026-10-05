import '@danfessler/trellis/style.css'
import {
  type Keymap,
  type LayoutDocument,
  type ViewHandle,
  type WorkspaceHandle,
  DEFAULT_KEYMAP,
  createWorkspace,
} from '@danfessler/trellis'
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useHydrated } from '@tanstack/react-router'
import { useMediaQuery } from '@purrable/ui'
import { WIDE_QUERY } from '../lib/breakpoints.ts'
import { PANE_MIN } from '../lib/pane-drop.ts'
import { PANE_TYPE, columnCount, singlePane } from '../lib/trellis-layout.ts'
import { type ItemKey, type WorkspaceState, appKey, isOpen, itemOf, order } from '../lib/workspace.ts'
import { AppsProvider, useApps } from './apps/provider.tsx'
import { WorkspaceAppSlot } from './apps/slot.tsx'
import { AppLayer } from './apps/stage.tsx'
import { ConversationPane, DraftPane, usePlace } from './conversation-pane.tsx'
import { PaneHeader } from './pane-header.tsx'
import { WorkspaceDrag } from './workspace-drag.tsx'
import { useWorkspace } from './workspace.tsx'

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

/** Trellis keeps none of its own shortcuts: hiding, floating or closing a pane belongs to the workspace store. */
const NO_KEYS: Keymap = Object.fromEntries(Object.keys(DEFAULT_KEYMAP).map((command) => [command, null]))

/** The App of the transcript (one at a time until Apps are durable), in a pane beside the conversation it came from. */
const APP_KEY = appKey('current')

type Hosts = RefObject<Map<ItemKey, HTMLDivElement>>
type Parking = RefObject<HTMLDivElement | null>

/**
 * Moves an item's stable host into `parent`, keeping focus inside it: React renders each item once into its host, and
 * only the host moves between panes, the strip and the parking lot. No MCP iframe is re-parented with these hosts.
 */
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

/** One host per open item, made as the item opens and removed once it is gone. */
function useHosts(items: readonly ItemKey[], parking: Parking): Hosts {
  const hosts = useRef(new Map<ItemKey, HTMLDivElement>())
  for (const item of items)
    if (!hosts.current.has(item)) {
      const host = document.createElement('div')
      host.className = 'workspace-pane-host'
      host.dataset.workspaceItem = item
      hosts.current.set(item, host)
    }
  useLayoutEffect(() => {
    const wanted = new Set(items)
    for (const [item, host] of hosts.current)
      if (!wanted.has(item)) {
        host.remove()
        hosts.current.delete(item)
      } else if (host.parentElement === null && parking.current) place(host, parking.current)
  }, [items, parking])
  return hosts
}

/** The document Trellis shows: the layout, or the one pane that fills the workspace. */
const shownDocument = (state: WorkspaceState, title: (key: ItemKey) => string): LayoutDocument =>
  state.maximized === undefined ? state.doc : singlePane(state.maximized, title(state.maximized))

type Live = { readonly workspace: ReturnType<typeof useWorkspace>; readonly apps: ReturnType<typeof useApps> }

function mountHost(hosts: Hosts, parking: Parking, latest: RefObject<Live>, element: HTMLElement, view: ViewHandle) {
  const host = hosts.current.get(view.id)
  if (host === undefined) return
  place(host, element)
  const off = view.subscribe(() => latest.current.apps.kick())
  return () => {
    off()
    if (parking.current) place(host, parking.current)
  }
}

/**
 * Trellis as a controlled layout: the store's document goes in; resizing a divider and focusing a pane come back. The
 * last document either side saw is remembered, so neither echoes the other.
 */
function connect(handle: WorkspaceHandle, latest: RefObject<Live>, applied: RefObject<string>): () => void {
  const offChange = handle.on('change', (doc) => {
    const { workspace } = latest.current
    const seen = JSON.stringify(doc)
    if (workspace.state.maximized !== undefined || seen === applied.current) return
    applied.current = seen
    workspace.resized(doc)
  })
  const offFocus = handle.on('focus', (id) => {
    if (id !== null && isOpen(latest.current.workspace.state, id)) latest.current.workspace.focus(id)
  })
  const kick = () => latest.current.apps.kick()
  const offSnapshot = handle.subscribe(kick)
  const theme = new MutationObserver(() =>
    handle.update({ theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light' }),
  )
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  const geometry = new MutationObserver(kick)
  geometry.observe(handle.element, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
  return () => {
    offChange()
    offFocus()
    offSnapshot()
    theme.disconnect()
    geometry.disconnect()
    handle.destroy()
  }
}

/**
 * The desktop workspace: Trellis lays the panes out, and wider than the screen allows (about 400px a pane) the layout
 * scrolls sideways. A newly focused pane scrolls into view.
 */
function WideLayout({ hosts, parking }: { readonly hosts: Hosts; readonly parking: Parking }) {
  const workspace = useWorkspace()
  const apps = useApps()
  const root = useRef<HTMLDivElement>(null)
  const handle = useRef<WorkspaceHandle | null>(null)
  const applied = useRef('')
  const latest = useRef<Live>({ workspace, apps })
  latest.current = { workspace, apps }
  const shown = useMemo(() => shownDocument(workspace.state, workspace.titleOf), [workspace.state, workspace.titleOf])
  useLayoutEffect(() => {
    if (root.current === null) return
    const doc = shownDocument(latest.current.workspace.state, latest.current.workspace.titleOf)
    applied.current = JSON.stringify(doc)
    const created = createWorkspace(root.current, {
      types: {
        [PANE_TYPE]: {
          tabbar: 'never',
          closable: false,
          scaling: false,
          allow: { stage: false, side: true, floating: false },
          minSize: PANE_MIN,
          mount: (element, view) => mountHost(hosts, parking, latest, element, view),
        },
      },
      document: doc,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      tokens: TOKENS,
      keymap: NO_KEYS,
      floating: false,
      navigation: false,
      panelMenu: false,
      onMissingType: () => 'drop',
      label: 'Workspace',
    })
    handle.current = created
    const disconnect = connect(created, latest, applied)
    return () => {
      disconnect()
      handle.current = null
    }
  }, [hosts, parking])
  useLayoutEffect(() => {
    const current = handle.current
    if (current === null) return
    const doc = JSON.stringify(shown)
    if (doc !== applied.current && !current.getSnapshot().dragging) {
      applied.current = doc
      current.setDocument(shown, { animate: true })
    }
    root.current?.style.setProperty('--workspace-columns', String(columnCount(shown.root)))
    const { focused } = workspace.state
    if (current.getSnapshot().focusedView !== focused && current.view(focused) !== null) current.focus(focused)
    apps.kick()
  }, [shown, workspace.state, apps])
  useEffect(() => {
    hosts.current
      .get(workspace.state.focused)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [workspace.state.focused, hosts])
  return (
    <div className="workspace-scroller" onScroll={apps.kick}>
      <div className="workspace-trellis" ref={root} data-testid="trellis" />
    </div>
  )
}

/** One screen-wide cell of the strip, holding its item's host. */
function StripCell({
  item,
  hosts,
  parking,
}: {
  readonly item: ItemKey
  readonly hosts: Hosts
  readonly parking: Parking
}) {
  const hold = useCallback(
    (cell: HTMLDivElement | null) => {
      const host = hosts.current.get(item)
      if (cell === null || host === undefined) return
      place(host, cell)
      return () => {
        if (parking.current) place(host, parking.current)
      }
    },
    [item, hosts, parking],
  )
  return <div className="workspace-cell" ref={hold} />
}

/** Which cell of the strip is in view. */
const cellAt = (strip: HTMLElement) => Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth))

/**
 * A narrow screen shows one pane at a time, in a strip that snaps pane by pane: the pane in view is the focused one,
 * and focusing another (from the sidebar or a link) scrolls to it.
 */
function NarrowStrip({
  items,
  hosts,
  parking,
}: {
  readonly items: readonly ItemKey[]
  readonly hosts: Hosts
  readonly parking: Parking
}) {
  const workspace = useWorkspace()
  const apps = useApps()
  const strip = useRef<HTMLDivElement>(null)
  // Set while the strip glides to the focused pane, so that scroll's end does not refocus anything.
  const steering = useRef(false)
  const placed = useRef(false)
  const { focused } = workspace.state
  const index = items.indexOf(focused)
  useLayoutEffect(() => {
    const element = strip.current
    const first = !placed.current
    placed.current = true
    if (element === null || index < 0 || cellAt(element) === index) return
    // The strip opens on the focused pane; afterwards focusing another glides to it.
    steering.current = !first
    element.scrollTo({ left: index * element.clientWidth, behavior: first ? 'instant' : 'smooth' })
  }, [index])
  const settle = () => {
    const element = strip.current
    if (element === null) return
    if (steering.current) {
      steering.current = false
      return
    }
    const shown = items[cellAt(element)]
    if (shown !== undefined && shown !== focused) workspace.focus(shown)
    apps.kick()
  }
  return (
    <div className="workspace-strip" ref={strip} onScrollEnd={settle}>
      {items.map((item) => (
        <StripCell key={item} item={item} hosts={hosts} parking={parking} />
      ))}
    </div>
  )
}

/** The App's pane: its pill, and the place the App's stage follows. */
function AppPane({ item }: { readonly item: ItemKey }) {
  const workspace = useWorkspace()
  const { session } = useApps()
  const { first, only } = usePlace(item)
  return (
    <section className="app-pane" aria-label="App">
      <PaneHeader
        item={item}
        title={session === undefined ? 'App' : `App · ${session.selection.serverId}`}
        first={first}
        onClose={only ? undefined : () => workspace.close(item)}
      />
      <WorkspaceAppSlot />
    </section>
  )
}

/** What an item's host shows. A pointer or focus inside a pane focuses it. */
function PaneContents({ item }: { readonly item: ItemKey }) {
  const workspace = useWorkspace()
  const parsed = itemOf(item)
  let contents = null
  if (parsed?.kind === 'conversation') contents = <ConversationPane id={parsed.id} />
  else if (parsed?.kind === 'draft') contents = <DraftPane item={item} />
  else if (parsed?.kind === 'app') contents = <AppPane item={item} />
  return (
    <div
      className="workspace-pane"
      data-focused={workspace.state.focused === item}
      onPointerDownCapture={() => workspace.focus(item)}
      onFocusCapture={() => workspace.focus(item)}
    >
      {contents}
    </div>
  )
}

/**
 * On a desktop the transcript's App opens in a pane beside the focused conversation, and the pane goes when the App
 * closes; closing the pane closes the App. A phone shows the App in its sheet instead.
 */
function useAppPane(wide: boolean): void {
  const { session, close } = useApps()
  const workspace = useWorkspace()
  const live = wide && session !== undefined
  const open = isOpen(workspace.state, APP_KEY)
  const wasOpen = useRef(false)
  useEffect(() => {
    const was = wasOpen.current
    wasOpen.current = open
    if (live && !open) {
      if (was) close()
      else workspace.open(APP_KEY, 'beside')
    } else if (!live && open) workspace.close(APP_KEY)
  }, [live, open, workspace, close])
}

function Surface() {
  const workspace = useWorkspace()
  const apps = useApps()
  const wide = useMediaQuery(WIDE_QUERY)
  const parking = useRef<HTMLDivElement>(null)
  const items = useMemo(() => order(workspace.state), [workspace.state])
  const hosts = useHosts(items, parking)
  useAppPane(wide)
  return (
    <div
      className="workspace-surface"
      ref={apps.slot('workspace-fullscreen')}
      data-workspace={wide ? 'wide' : 'narrow'}
    >
      <div className="workspace-parking" ref={parking} inert aria-hidden />
      {wide && <WorkspaceDrag />}
      {wide ? (
        <WideLayout hosts={hosts} parking={parking} />
      ) : (
        <NarrowStrip items={items} hosts={hosts} parking={parking} />
      )}
      {items.map((item) => {
        const host = hosts.current.get(item)
        return host === undefined ? null : createPortal(<PaneContents item={item} />, host, item)
      })}
    </div>
  )
}

/**
 * The owner's panes, each showing one conversation, draft or App. Trellis and the strip are DOM-only, so nothing
 * renders until the page has hydrated.
 */
export function WorkspaceSurface() {
  const hydrated = useHydrated()
  return (
    <AppsProvider>
      <section className="workspace" aria-label="Workspace">
        {hydrated && <Surface />}
      </section>
      <AppLayer />
    </AppsProvider>
  )
}
