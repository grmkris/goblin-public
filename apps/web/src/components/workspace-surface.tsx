import '@danfessler/trellis/style.css'
import {
  type Keymap,
  type LayoutDocument,
  type ViewHandle,
  type WorkspaceHandle,
  DEFAULT_KEYMAP,
  createWorkspace,
} from '@danfessler/trellis'
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useHydrated } from '@tanstack/react-router'
import { Button, Sheet, SheetContent, SheetTitle, useMediaQuery } from '@goblin/ui'
import { MessageSquareIcon } from 'lucide-react'
import { WIDE_QUERY } from '../lib/breakpoints.ts'
import { PANE_MIN } from '../lib/pane-drop.ts'
import { PANE_TYPE, columnCount, dockedDocument, dockedShare, singlePane } from '../lib/trellis-layout.ts'
import { type ItemKey, type WorkspaceState, dockOf, isOpen, itemOf, order } from '../lib/workspace.ts'
import { AppHost, useAppHost } from './apps/host.tsx'
import { AppPage } from './apps/page.tsx'
import { AppLayer } from './apps/stage.tsx'
import { ConversationPane, DraftPane } from './conversation-pane.tsx'
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

/**
 * The document Trellis shows: the layout, or the one pane that fills the workspace, an App's with its conversation
 * docked beside it unless the owner folded the dock away.
 */
function shownDocument(state: WorkspaceState, title: (key: ItemKey) => string): LayoutDocument {
  const { maximized, docked } = state
  if (maximized === undefined) return state.doc
  const dock = dockOf(state)
  return docked === undefined || !dock.open
    ? singlePane(maximized, title(maximized))
    : dockedDocument(maximized, title(maximized), docked, title(docked), dock.share)
}

/** How far the docked chat's share must move to count as the owner's drag rather than rounding. */
const DOCK_DRAG = 0.01

/** The items with a host: every pane's, and the conversation docked beside a full-screen App. */
const hostedItems = (state: WorkspaceState): ItemKey[] => {
  const items = order(state)
  return state.docked === undefined || items.includes(state.docked) ? items : [...items, state.docked]
}

type Live = { readonly workspace: ReturnType<typeof useWorkspace>; readonly apps: ReturnType<typeof useAppHost> }

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
    const { state } = workspace
    if (state.maximized !== undefined) {
      // Only a drag of the docked chat's edge moves its share; Trellis echoing the document it was given does not.
      const share = state.docked === undefined ? undefined : dockedShare(doc)
      if (share !== undefined && Math.abs(share - dockOf(state).share) > DOCK_DRAG) workspace.setDock({ share })
      return
    }
    const seen = JSON.stringify(doc)
    if (seen === applied.current) return
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
  const apps = useAppHost()
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

/**
 * On a phone, the conversation docked beside a full-screen App, in a sheet from the bottom (ADR 0021): half the screen
 * or, with its handle, nearly all of it. The conversation's own pane moves in while it is open, so its stream and draft
 * go on; folded away, a Chat button brings it back.
 */
function ChatSheet({
  item,
  hosts,
  parking,
}: {
  readonly item: ItemKey
  readonly hosts: Hosts
  readonly parking: Parking
}) {
  const workspace = useWorkspace()
  const { open } = dockOf(workspace.state)
  const [full, setFull] = useState(false)
  const hold = useCallback(
    (body: HTMLDivElement | null) => {
      const host = hosts.current.get(item)
      if (body === null || host === undefined) return
      place(host, body)
      return () => {
        if (parking.current) place(host, parking.current)
      }
    },
    [item, hosts, parking],
  )
  return (
    <>
      {!open && (
        <div className="chat-sheet-button">
          <Button onClick={() => workspace.setDock({ open: true })}>
            <MessageSquareIcon aria-hidden />
            Chat
          </Button>
        </div>
      )}
      <Sheet open={open} onOpenChange={(next) => workspace.setDock({ open: next })}>
        <SheetContent side="bottom" showCloseButton={false}>
          <div className="chat-sheet" data-full={full}>
            <SheetTitle className="sr-only">{workspace.titleOf(item)}</SheetTitle>
            <button
              type="button"
              className="chat-sheet-handle"
              aria-label={full ? 'Half height' : 'Full height'}
              onClick={() => setFull(!full)}
            />
            <div className="chat-sheet-body" ref={hold} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

/** Browsers without `scrollend` (Safari before 26.2): the strip settles once its scrolling has been quiet a moment. */
const SCROLLEND = typeof window === 'undefined' || 'onscrollend' in window
const SCROLL_QUIET_MS = 150

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
  const apps = useAppHost()
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
  const quiet = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(quiet.current), [])
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
  const { maximized, docked } = workspace.state
  if (maximized !== undefined && docked !== undefined)
    return (
      <div className="workspace-strip">
        <StripCell item={maximized} hosts={hosts} parking={parking} />
        <ChatSheet item={docked} hosts={hosts} parking={parking} />
      </div>
    )
  return (
    <div
      className="workspace-strip"
      ref={strip}
      onScrollEnd={settle}
      {...(!SCROLLEND && {
        onScroll: () => {
          clearTimeout(quiet.current)
          quiet.current = setTimeout(settle, SCROLL_QUIET_MS)
        },
      })}
    >
      {items.map((item) => (
        <StripCell key={item} item={item} hosts={hosts} parking={parking} />
      ))}
    </div>
  )
}

/** What an item's host shows. A pointer or focus inside a pane focuses it. */
function PaneContents({ item }: { readonly item: ItemKey }) {
  const workspace = useWorkspace()
  const parsed = itemOf(item)
  let contents = null
  if (parsed?.kind === 'conversation') contents = <ConversationPane id={parsed.id} />
  else if (parsed?.kind === 'draft') contents = <DraftPane item={item} />
  else if (parsed?.kind === 'app') contents = <AppPage item={item} id={parsed.id} />
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

function Surface() {
  const workspace = useWorkspace()
  const wide = useMediaQuery(WIDE_QUERY)
  const parking = useRef<HTMLDivElement>(null)
  const items = useMemo(() => order(workspace.state), [workspace.state])
  const hosted = useMemo(() => hostedItems(workspace.state), [workspace.state])
  const hosts = useHosts(hosted, parking)
  return (
    <div className="workspace-surface" data-workspace={wide ? 'wide' : 'narrow'}>
      <div className="workspace-parking" ref={parking} inert aria-hidden />
      {wide && <WorkspaceDrag />}
      {wide ? (
        <WideLayout hosts={hosts} parking={parking} />
      ) : (
        <NarrowStrip items={items} hosts={hosts} parking={parking} />
      )}
      {hosted.map((item) => {
        const host = hosts.current.get(item)
        return host === undefined ? null : createPortal(<PaneContents item={item} />, host, item)
      })}
    </div>
  )
}

/**
 * The owner's panes, each showing one conversation, draft or App page, and above them the stages of the live Apps.
 * Trellis and the strip are DOM-only, so nothing renders until the page has hydrated.
 */
export function WorkspaceSurface() {
  const hydrated = useHydrated()
  return (
    <AppHost>
      <section className="workspace" aria-label="Workspace">
        {hydrated && <Surface />}
      </section>
      <AppLayer />
    </AppHost>
  )
}
