import { useAccountWorkspaces } from '../lib/account-workspaces.tsx'
import { type ReactNode, createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LayoutDocument } from '@danfessler/trellis'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { record, request } from '../lib/boundary.ts'
import type { Part } from '../lib/parts.ts'
import { threadTitle } from '../lib/threads.ts'
import {
  type ItemKey,
  type Where,
  type WorkspaceState,
  closeItem,
  conversationKey,
  draftKey,
  focusItem,
  initialWorkspace,
  isOpen,
  itemOf,
  maximizeItem,
  openItem,
  parseWorkspace,
  prune,
  replaceItem,
  resized,
  retitle,
  serializeWorkspace,
  workspaceStorageKey,
} from '../lib/workspace.ts'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** A message to start a thread from: the conversation and its entry. */
type From = { readonly conversation: string; readonly entry: number }

type Workspace = {
  readonly state: WorkspaceState
  /** Opens an item in a pane (`lib/workspace.ts` `openItem`): `source` is the pane it was opened from. */
  readonly open: (key: ItemKey, where: Where, source?: ItemKey) => void
  /** Closes a pane (never the last). The item itself goes on. */
  readonly close: (key: ItemKey) => void
  readonly focus: (key: ItemKey) => void
  /** The pane showing `from` shows `to` in its place: a draft once its thread exists. */
  readonly replace: (from: ItemKey, to: ItemKey) => void
  readonly maximize: (key: ItemKey | undefined) => void
  /** The layout after the owner resized panes in Trellis. */
  readonly resized: (doc: LayoutDocument) => void
  /** A draft beside `source`: a reply to a message (shown above the draft as `root`), or a new empty thread. */
  readonly draft: (from: From | undefined, root: readonly Part[], source: ItemKey) => void
  /** The message a reply draft answers, as its source showed it. */
  readonly draftRoot: (key: ItemKey) => readonly Part[]
  readonly titleOf: (key: ItemKey) => string
}

const WorkspaceContext = createContext<Workspace | undefined>(undefined)

export function useWorkspace(): Workspace {
  const workspace = use(WorkspaceContext)
  if (workspace === undefined) throw new Error('useWorkspace outside WorkspaceProvider')
  return workspace
}

/** The conversation the URL names (`/c/<id>`), as an item. */
const urlItem = (path: string): ItemKey | undefined => {
  const id = /^\/c\/(\d{1,12})$/u.exec(path)?.[1]
  return id === undefined ? undefined : conversationKey(id)
}

/** The signed-in user's id: the device keeps one workspace per person. */
function useOwner(enabled: boolean): string | undefined {
  const [owner, setOwner] = useState<string>()
  const { state } = useAccountWorkspaces()
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    request('/api/auth/get-session', { signal: controller.signal })
      .then((data) => {
        const id = record(record(data)?.user)?.id
        if (typeof id === 'string' && !controller.signal.aborted) setOwner(id)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [enabled])
  return owner === undefined || state?.active === undefined || state.active === null
    ? undefined
    : `${owner}:${state.active.id}:${state.active.memberVersion}`
}

/**
 * Restores this device's panes for `owner` once, with the URL's item focused, then keeps storing them. Storage is a
 * device preference: blocked or broken storage leaves the workspace in memory.
 */
function useStoredState(owner: string | undefined, url: ItemKey | undefined, title: (key: ItemKey) => string) {
  const [state, setState] = useState<WorkspaceState>(initialWorkspace)
  const [loaded, setLoaded] = useState<string>()
  useEffect(() => {
    if (owner === undefined || loaded === owner) return
    let stored: WorkspaceState | undefined
    try {
      stored = parseWorkspace(localStorage.getItem(workspaceStorageKey(owner)))
    } catch {
      stored = undefined
    }
    const base = stored ?? initialWorkspace()
    setState(
      url === undefined || isOpen(base, url)
        ? focusItem(base, url ?? base.focused)
        : openItem(base, url, title(url), 'beside'),
    )
    setLoaded(owner)
  }, [owner, loaded, url, title])
  useEffect(() => {
    if (owner === undefined || loaded !== owner) return
    try {
      localStorage.setItem(workspaceStorageKey(owner), serializeWorkspace(state))
    } catch {
      /* Optional device arrangement. */
    }
  }, [owner, loaded, state])
  return [state, setState, owner !== undefined && loaded === owner] as const
}

/**
 * The URL names the focused conversation (`/c/<id>`, replaced as focus moves, so Back leaves the workspace rather than
 * stepping through panes); `/` takes the restored focus. A URL that names another item, from a link, Back or a typed
 * address, opens it beside the focused pane, or focuses it where it is.
 */
function useUrlFocus(
  state: WorkspaceState,
  setState: (change: (state: WorkspaceState) => WorkspaceState) => void,
  title: (key: ItemKey) => string,
  ready: boolean,
) {
  const path = useRouterState({ select: (router) => router.location.pathname })
  const navigate = useNavigate()
  const url = urlItem(path)
  useEffect(() => {
    if (url !== undefined) setState((current) => openItem(current, url, title(url), 'beside'))
    // Only a change of the URL itself opens anything; titles arriving later change nothing here.
  }, [url, setState])
  // Focus drives the URL only when focus itself moved (or `/` asks for it), never back against a URL just opened.
  const focused = useRef(state.focused)
  useEffect(() => {
    const moved = focused.current !== state.focused
    focused.current = state.focused
    const item = itemOf(state.focused)
    if (!ready || item?.kind !== 'conversation' || url === state.focused) return
    if ((url !== undefined && moved) || path === '/')
      void navigate({ to: '/c/$conversationId', params: { conversationId: item.id }, replace: true })
  }, [state.focused, url, path, ready, navigate])
}

/**
 * The owner's panes for the whole app, so the sidebar and every transcript link can open things in them, and the
 * layout survives a visit to Settings. The panes themselves render only on workspace pages (`workspace-surface.tsx`).
 */
export function WorkspaceProvider({ enabled, children }: { readonly enabled: boolean; readonly children: ReactNode }) {
  const feed = useWorkspaceFeed()
  const views = useRef(feed.conversations)
  views.current = feed.conversations
  const title = useCallback((key: ItemKey): string => {
    const item = itemOf(key)
    if (item?.kind === 'conversation') return threadTitle(views.current.find((view) => view.id === item.id))
    return item?.kind === 'app' ? 'App' : 'New thread'
  }, [])
  const path = useRouterState({ select: (router) => router.location.pathname })
  const [state, setState, ready] = useStoredState(useOwner(enabled), urlItem(path), title)
  useUrlFocus(state, setState, title, ready)
  const roots = useRef(new Map<ItemKey, readonly Part[]>())
  // Conversations that are gone (or drafts whose conversation is) close; titles follow the feed.
  useEffect(() => {
    if (feed.conversations.length === 0) return
    const known = new Set(feed.conversations.map((view) => view.id))
    const keep = (key: ItemKey) => {
      const item = itemOf(key)
      if (item?.kind === 'conversation') return known.has(item.id)
      return item?.kind !== 'draft' || item.from === undefined || known.has(item.from.conversation)
    }
    setState((current) => retitle(prune(current, keep), title))
  }, [feed.conversations, setState, title])
  const value = useMemo<Workspace>(
    () => ({
      state,
      open: (key, where, source) => setState((current) => openItem(current, key, title(key), where, source)),
      close: (key) => {
        roots.current.delete(key)
        setState((current) => closeItem(current, key))
      },
      focus: (key) => setState((current) => focusItem(current, key)),
      replace: (from, to) => {
        roots.current.delete(from)
        setState((current) => replaceItem(current, from, to, title(to)))
      },
      maximize: (key) => setState((current) => maximizeItem(current, key)),
      resized: (doc) => setState((current) => resized(current, doc)),
      draft: (from, root, source) => {
        const key = draftKey(from)
        roots.current.set(key, root)
        setState((current) => openItem(current, key, title(key), 'beside', source))
      },
      draftRoot: (key) => roots.current.get(key) ?? [],
      titleOf: title,
    }),
    [state, setState, title],
  )
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>
}
