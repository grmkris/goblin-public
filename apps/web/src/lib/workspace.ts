import type { Edge, LayoutDocument } from '@danfessler/trellis'
import { MAIN_THREAD } from '@purrable/contracts'
import { record } from './boundary.ts'
import { balanced, insertBeside, leafOrder, replaceView, singlePane, swapViews, withoutView } from './trellis-layout.ts'
import { parseLayoutDocument } from './workspace-document.ts'

/**
 * What a pane shows: a conversation (`c:<id>`), an App (`a:<id>`), or a draft that becomes a thread when it is sent:
 * a reply to a message (`d:<conversation>:<entry>`) or a new empty thread (`d:new`). Item keys are the Trellis view
 * ids and the keys of the stable hosts, so moving an item between panes moves its live view with it.
 */
export type ItemKey = string

export type Item =
  | { readonly kind: 'conversation'; readonly id: string }
  | { readonly kind: 'app'; readonly id: string }
  | { readonly kind: 'draft'; readonly from?: { readonly conversation: string; readonly entry: number } }

export const conversationKey = (id: string): ItemKey => `c:${id}`
export const appKey = (id: string): ItemKey => `a:${id}`
export const draftKey = (from?: { readonly conversation: string; readonly entry: number }): ItemKey =>
  from === undefined ? 'd:new' : `d:${from.conversation}:${from.entry}`
export const MAIN_KEY = conversationKey(MAIN_THREAD)

const DIGITS = /^\d{1,12}$/u

/** The item a key names, or `undefined` for anything else. */
export function itemOf(key: ItemKey): Item | undefined {
  const [kind, first = '', second, ...rest] = key.split(':')
  if (rest.length > 0) return undefined
  if (kind === 'c' && second === undefined && DIGITS.test(first)) return { kind: 'conversation', id: first }
  if (kind === 'a' && second === undefined && DIGITS.test(first)) return { kind: 'app', id: first }
  if (kind !== 'd') return undefined
  if (first === 'new' && second === undefined) return { kind: 'draft' }
  const entry = Number(second)
  return DIGITS.test(first) && Number.isSafeInteger(entry) && entry > 0
    ? { kind: 'draft', from: { conversation: first, entry } }
    : undefined
}

/**
 * The panes of this device: a Trellis document whose panes each show one item, the focused item (the one the URL
 * names) and, while one pane fills the workspace, that item.
 */
export type WorkspaceState = {
  readonly doc: LayoutDocument
  readonly focused: ItemKey
  readonly maximized?: ItemKey
}

/**
 * Where an item opens: `here` in place of the focused item, `beside` the focused item (or `source`), at an `edge` of
 * the pane showing `target`, or `into` that pane in place of what it shows.
 */
export type Where = 'here' | 'beside' | { readonly target: ItemKey; readonly edge: Edge } | { readonly into: ItemKey }

/** Main alone: where a device without a stored workspace starts. */
export const initialWorkspace = (title = 'Main'): WorkspaceState => ({
  doc: singlePane(MAIN_KEY, title),
  focused: MAIN_KEY,
})

/** The items in reading order: left to right, top to bottom. On a narrow screen this is the strip, one per screen. */
export const order = (state: WorkspaceState): ItemKey[] => leafOrder(state.doc)

/** Whether a pane shows `key`. */
export const isOpen = (state: WorkspaceState, key: ItemKey): boolean => key in state.doc.views

const settle = (state: WorkspaceState, doc: LayoutDocument, focused: ItemKey): WorkspaceState => {
  const { maximized: _cleared, ...rest } = state
  return { ...rest, doc: balanced(doc), focused }
}

/**
 * Opens `key` in a pane. An item is never in two panes: one already open is focused where it is, unless dropped at
 * another pane's edge (it moves there) or onto another pane (the two trade places). Every change ends with even shares.
 */
export function openItem(
  state: WorkspaceState,
  key: ItemKey,
  title: string,
  where: Where,
  source: ItemKey = state.focused,
): WorkspaceState {
  if (typeof where === 'object')
    return 'into' in where ? dropInto(state, key, title, where.into) : dropAt(state, key, title, where)
  if (isOpen(state, key)) return focusItem(state, key)
  const anchor = isOpen(state, source) ? source : (order(state)[0] ?? MAIN_KEY)
  if (where === 'here') return settle(state, replaceView(state.doc, anchor, key, title), key)
  return settle(state, insertBeside(state.doc, anchor, key, title, 'right'), key)
}

/** Dropped onto the pane showing `into`: an open item trades places with it, a new one takes its place. */
function dropInto(state: WorkspaceState, key: ItemKey, title: string, into: ItemKey): WorkspaceState {
  if (into === key || !isOpen(state, into)) return focusItem(state, key)
  if (isOpen(state, key)) return settle(state, swapViews(state.doc, key, into), key)
  return settle(state, replaceView(state.doc, into, key, title), key)
}

/** Dropped at an edge of the pane showing `target`: a new pane there, moving the item if it was open elsewhere. */
function dropAt(
  state: WorkspaceState,
  key: ItemKey,
  title: string,
  { target, edge }: { readonly target: ItemKey; readonly edge: Edge },
): WorkspaceState {
  if (target === key || !isOpen(state, target)) return focusItem(state, key)
  const doc = isOpen(state, key) ? withoutView(state.doc, key) : state.doc
  return settle(state, insertBeside(doc, target, key, title, edge), key)
}

/** Focus a pane that is open; anything else changes nothing. */
export function focusItem(state: WorkspaceState, key: ItemKey): WorkspaceState {
  return isOpen(state, key) && state.focused !== key ? { ...state, focused: key } : state
}

/**
 * Closes the pane showing `key` (the item itself stays: a conversation goes on, a draft is simply gone). The last pane
 * never closes. Focus moves to the pane before it, or the one after.
 */
export function closeItem(state: WorkspaceState, key: ItemKey): WorkspaceState {
  const items = order(state)
  if (!isOpen(state, key) || items.length <= 1) return state
  const index = items.indexOf(key)
  const focused = state.focused === key ? (items[index - 1] ?? items[index + 1] ?? MAIN_KEY) : state.focused
  return settle(state, withoutView(state.doc, key), focused)
}

/** The pane showing `from` shows `to` in its place (a draft once its thread exists); focus follows. */
export function replaceItem(state: WorkspaceState, from: ItemKey, to: ItemKey, title: string): WorkspaceState {
  if (!isOpen(state, from) || isOpen(state, to)) return state
  return {
    ...state,
    doc: replaceView(state.doc, from, to, title),
    focused: state.focused === from ? to : state.focused,
  }
}

/** One pane fills the workspace, or (with `undefined`) all of them share it again. */
export function maximizeItem(state: WorkspaceState, key: ItemKey | undefined): WorkspaceState {
  const { maximized: _cleared, ...rest } = state
  return key === undefined || !isOpen(state, key) ? rest : { ...rest, maximized: key, focused: key }
}

/** The document Trellis reports after the owner resized panes: taken as is when it shows the same items. */
export function resized(state: WorkspaceState, doc: LayoutDocument): WorkspaceState {
  const same = new Set(order(state))
  const next = leafOrder(doc)
  return next.length === same.size && next.every((key) => same.has(key)) ? { ...state, doc } : state
}

/** Titles as they are now; Trellis shows them as the panes' accessible names. */
export function retitle(state: WorkspaceState, title: (key: ItemKey) => string): WorkspaceState {
  let changed = false
  const views = Object.fromEntries(
    Object.entries(state.doc.views).map(([key, view]) => {
      const next = title(key)
      if (next !== view.title) changed = true
      return [key, { ...view, title: next }]
    }),
  )
  return changed ? { ...state, doc: { ...state.doc, views } } : state
}

/** Closes the panes whose items `keep` no longer accepts (a conversation that is gone, an App that ended). */
export function prune(state: WorkspaceState, keep: (key: ItemKey) => boolean): WorkspaceState {
  let next = state
  for (const key of order(state)) if (!keep(key)) next = closeItem(next, key)
  const left = order(next)
  if (left.length === 1 && !keep(left[0] ?? '')) return initialWorkspace()
  return next
}

/** The storage key of a device's workspace for one owner. */
export const workspaceStorageKey = (owner: string): string => `purrable:workspace:v2:${owner}`

/**
 * A stored workspace: conversation and App panes come back (drafts need what the owner did this time; an App comes
 * back from the registry, never with a grant), bounded as `parseLayoutDocument` bounds it, with a focus that is open.
 */
export function parseWorkspace(raw: string | null): WorkspaceState | undefined {
  if (raw === null || raw.length > 128_000) return undefined
  try {
    const value = record(JSON.parse(raw))
    const doc = parseLayoutDocument(value?.doc, (key) => itemOf(key)?.kind !== 'draft' && itemOf(key) !== undefined)
    if (doc === undefined) return undefined
    const items = leafOrder(doc)
    const focused = typeof value?.focused === 'string' && items.includes(value.focused) ? value.focused : items[0]
    return focused === undefined ? undefined : { doc, focused }
  } catch {
    return undefined
  }
}

/** What `parseWorkspace` reads back. */
export const serializeWorkspace = (state: WorkspaceState): string =>
  JSON.stringify({ doc: state.doc, focused: state.focused })
