// What the sidebar's Pinned section shows (ADR 0053): the owner's stored pins that still lead somewhere, then the
// connected servers with their own App that it pins on its own until the owner changes the pins. Pure.
import {
  type AppView,
  type ServerView,
  type SidebarOperation,
  type SidebarPin,
  type SidebarPins,
  type SidebarTarget,
  pinKey,
} from '@goblin/contracts'
import { entrypoints } from './entrypoints.ts'

/** A pinned row as the sidebar draws it: a server's own App, or one App view. */
export type ShownPin =
  | { readonly kind: 'server'; readonly connectionId: string; readonly title: string }
  | { readonly kind: 'view'; readonly appId: string; readonly title: string; readonly app: AppView }

/** The rows, and the servers among them the owner has not stored yet (an edit adopts them first). */
export type Pinned = { readonly shown: readonly ShownPin[]; readonly adopt: readonly string[] }

/** A pin's target: what an unpin or a move names. */
export const targetOf = (pin: ShownPin | SidebarPin): SidebarTarget =>
  pin.kind === 'server' ? { kind: 'server', connectionId: pin.connectionId } : { kind: 'view', appId: pin.appId }

/**
 * The rows: each stored pin whose server is connected with its own App, or whose App is still kept, in the owner's
 * order; then each such server the sidebar has never pinned (`seen`), pinned for the owner. A pin of a server signed out
 * hides until it is back, in its place.
 */
export function pinnedRows(stored: SidebarPins, servers: readonly ServerView[], apps: readonly AppView[]): Pinned {
  const open = new Map(entrypoints(servers).map((entry) => [entry.connectionId, entry.title]))
  const kept = new Map(apps.map((app) => [app.id, app]))
  const shown: ShownPin[] = stored.pins.flatMap((pin): ShownPin[] => {
    if (pin.kind === 'server') {
      const title = open.get(pin.connectionId)
      return title === undefined ? [] : [{ kind: 'server', connectionId: pin.connectionId, title }]
    }
    const app = kept.get(pin.appId)
    return app === undefined ? [] : [{ kind: 'view', appId: pin.appId, title: pin.title, app }]
  })
  const pinned = new Set(stored.pins.map(pinKey))
  const seen = new Set(stored.seen)
  const adopt = [...open.keys()].filter(
    (connectionId) => !seen.has(connectionId) && !pinned.has(pinKey({ kind: 'server', connectionId })),
  )
  for (const connectionId of adopt) shown.push({ kind: 'server', connectionId, title: open.get(connectionId) ?? '' })
  return { shown, adopt }
}

/** The stored pins once `adopt` is stored: what an edit's indexes count. */
const afterAdopt = (stored: SidebarPins, adopt: readonly string[]): readonly SidebarPin[] => [
  ...stored.pins,
  ...adopt.map((connectionId) => ({ kind: 'server', connectionId }) as const),
]

/**
 * The operation that moves `target` one row up (`-1`) or down (`1`) among the rows shown: to its neighbour's place among
 * the stored pins, which may hold rows that are hidden. Undefined at either end.
 */
export function moveOperation(
  stored: SidebarPins,
  pinned: Pinned,
  target: SidebarTarget,
  step: -1 | 1,
): SidebarOperation | undefined {
  const at = pinned.shown.findIndex((pin) => pinKey(pin) === pinKey(target))
  const neighbour = at === -1 ? undefined : pinned.shown[at + step]
  if (neighbour === undefined) return undefined
  const index = afterAdopt(stored, pinned.adopt).findIndex((pin) => pinKey(pin) === pinKey(neighbour))
  return index === -1 ? undefined : { kind: 'move', target, index }
}

/** What pinning an App pins: a server's own App pins its server; any other App, that one view under `name`. */
export const appPin = (app: AppView, name: string): SidebarPin =>
  app.source.kind === 'mcp' && app.source.entrypoint === true
    ? { kind: 'server', connectionId: app.source.connectionId }
    : { kind: 'view', appId: app.id, title: name.slice(0, 120) || 'App' }
