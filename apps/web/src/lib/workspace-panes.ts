import type { ThreadView } from '@purrable/contracts'
import { record } from './boundary.ts'

export type Pane =
  | { readonly id: 'main'; readonly kind: 'main' }
  | { readonly id: string; readonly kind: 'thread'; readonly thread: string }
  | { readonly id: string; readonly kind: 'draft'; readonly entry?: number }
  | { readonly id: string; readonly kind: 'app'; readonly serverId: string; readonly key: string }
export type PaneState = { readonly panes: readonly Pane[]; readonly focused: string }
export const MAIN_PANE: Pane = { id: 'main', kind: 'main' }
export const initialPanes = (): PaneState => ({ panes: [MAIN_PANE], focused: 'main' })
export const threadPane = (thread: string): Pane => ({ id: `thread:${thread}`, kind: 'thread', thread })
export const draftPane = (entry?: number): Pane => ({
  id: `draft:${entry ?? 'new'}`,
  kind: 'draft',
  ...(entry === undefined ? {} : { entry }),
})
export const appPane = (serverId: string, key: string): Pane => ({
  id: `app:${encodeURIComponent(serverId)}:${encodeURIComponent(key)}`,
  kind: 'app',
  serverId,
  key,
})

/** Opening an existing pane focuses its stable host; main can never be closed. */
export function openPane(state: PaneState, pane: Pane): PaneState {
  if (state.focused === pane.id && state.panes.some((item) => item.id === pane.id)) return state
  return {
    panes: state.panes.some((item) => item.id === pane.id) ? state.panes : [...state.panes, pane],
    focused: pane.id,
  }
}
export function closePane(state: PaneState, id: string): PaneState {
  if (id === 'main' || !state.panes.some((pane) => pane.id === id)) return state
  return { panes: state.panes.filter((pane) => pane.id !== id), focused: state.focused === id ? 'main' : state.focused }
}
export function reconcilePanes(state: PaneState, views: readonly ThreadView[], app: Pane | undefined): PaneState {
  const live = new Set(views.filter((view) => !view.archived && view.kind !== 'main').map((view) => view.id))
  const panes = state.panes.filter(
    (pane) =>
      pane.kind === 'main' ||
      pane.kind === 'draft' ||
      (pane.kind === 'thread' ? live.has(pane.thread) : pane.id === app?.id),
  )
  const focused = panes.some((pane) => pane.id === state.focused) ? state.focused : 'main'
  return panes.length === state.panes.length && focused === state.focused ? state : { panes, focused }
}

const paneOf = (value: unknown): Pane | undefined => {
  const item = record(value)
  if (item?.kind === 'main') return MAIN_PANE
  if (item?.kind === 'thread' && typeof item.thread === 'string' && /^\d{1,12}$/u.test(item.thread))
    return threadPane(item.thread)
  // Drafts and apps are ephemeral: persisted metadata never restores an authorized app selection.
  return undefined
}

/** v0 was an unversioned list of thread ids. v1 stores typed panes; invalid/future formats reset safely. */
export function parsePanes(raw: string | null): PaneState {
  if (raw === null || raw.length > 64_000) return initialPanes()
  try {
    const data = record(JSON.parse(raw))
    const old =
      (data?.version === undefined || data.version === 0) && Array.isArray(data?.threads)
        ? data.threads.map((thread: unknown) => ({ kind: 'thread', thread }))
        : undefined
    const items = old ?? (data?.version === 1 && Array.isArray(data.panes) ? data.panes : [])
    const panes = new Map<string, Pane>([['main', MAIN_PANE]])
    for (const item of items.slice(0, 64)) {
      const pane = paneOf(item)
      if (pane !== undefined) panes.set(pane.id, pane)
    }
    return {
      panes: [...panes.values()],
      focused: typeof data?.focused === 'string' && panes.has(data.focused) ? data.focused : 'main',
    }
  } catch {
    return initialPanes()
  }
}
export function syncAppPane(state: PaneState, app: Pane | undefined): PaneState {
  return app === undefined || state.panes.some((pane) => pane.id === app.id) ? state : openPane(state, app)
}
export const workspaceStorageKey = (owner: string, primary: string) => `purrable:workspace:v1:${owner}:${primary}`
