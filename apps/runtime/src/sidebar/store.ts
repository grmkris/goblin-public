import {
  EMPTY_SIDEBAR,
  MAX_PINS,
  MAX_SEEN,
  type SidebarEdit,
  type SidebarPin,
  SidebarPins,
  type SidebarTarget,
  pinKey,
} from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Schema from 'effect/Schema'
import { InvalidInput } from '../http/errors.ts'
import { appSidebar } from '../storage/schema.ts'

/** The agent's synchronous SQLite, or a transaction on it. */
type SidebarDb<RunResult> = Pick<SQLiteAsyncDatabase<'sync', RunResult>, 'select' | 'insert'>

/** Pins checked against their bounds (count, one of each): what is stored, read back or made by an edit. */
const sidebarPins: (pins: unknown) => SidebarPins = Schema.decodeUnknownSync(SidebarPins)

export const readSidebar = <RunResult>(db: SidebarDb<RunResult>): SidebarPins => {
  const row = db.select().from(appSidebar).where(eq(appSidebar.id, 1)).get()
  return row === undefined ? EMPTY_SIDEBAR : sidebarPins(JSON.parse(row.pins))
}

export function writeSidebar<RunResult>(db: SidebarDb<RunResult>, sidebar: SidebarPins): void {
  const valid = sidebarPins(sidebar)
  const values = { id: 1, revision: valid.revision, pins: JSON.stringify(valid) }
  db.insert(appSidebar).values(values).onConflictDoUpdate({ target: appSidebar.id, set: values }).run()
}

/** `pins` without the one `target` names. */
const without = (pins: readonly SidebarPin[], target: SidebarTarget) =>
  pins.filter((pin) => pinKey(pin) !== pinKey(target))

/** `pins` with `pin` at `index` (clamped), else last. */
const placed = (pins: readonly SidebarPin[], pin: SidebarPin, index: number | undefined) => {
  const at = Math.min(index ?? pins.length, pins.length)
  return [...pins.slice(0, at), pin, ...pins.slice(at)]
}

/** The servers remembered as pinned once, the newest last, at most `MAX_SEEN`. */
const remembered = (seen: ReadonlySet<string>) => [...seen].slice(-MAX_SEEN)

/**
 * The pins after `edit`, a revision on: the servers it adopts stored first (each pinned last, unless the owner already
 * changed it), then its pin, unpin or move. A server pinned or unpinned is remembered, so the sidebar never pins it on
 * its own again. Refused when it would keep more than `MAX_PINS`.
 */
export function editedSidebar(current: SidebarPins, edit: SidebarEdit): SidebarPins {
  const seen = new Set(current.seen)
  let pins: readonly SidebarPin[] = current.pins
  for (const connectionId of edit.adopt ?? []) {
    const pin = { kind: 'server', connectionId } as const
    if (!seen.has(connectionId) && !pins.some((each) => pinKey(each) === pinKey(pin))) pins = [...pins, pin]
    seen.add(connectionId)
  }
  const { op } = edit
  if (op.kind === 'pin') pins = placed(without(pins, op.pin), op.pin, op.index)
  else if (op.kind === 'unpin') pins = without(pins, op.target)
  else {
    const pin = pins.find((each) => pinKey(each) === pinKey(op.target))
    if (pin !== undefined) pins = placed(without(pins, op.target), pin, op.index)
  }
  const target = op.kind === 'pin' ? op.pin : op.target
  if (target.kind === 'server') seen.add(target.connectionId)
  if (pins.length > MAX_PINS) throw new InvalidInput({ reason: `The sidebar keeps ${MAX_PINS} pins; unpin one first` })
  return { revision: current.revision + 1, pins, seen: remembered(seen) }
}

/**
 * The pins without a removed connection's server, which is forgotten too (added again, it is pinned again); undefined
 * when nothing changes.
 */
export function withoutServer(current: SidebarPins, connectionId: string): SidebarPins | undefined {
  const target = { kind: 'server', connectionId } as const
  const pins = without(current.pins, target)
  if (pins.length === current.pins.length && !current.seen.includes(connectionId)) return undefined
  return { revision: current.revision + 1, pins, seen: current.seen.filter((id) => id !== connectionId) }
}

/** The pins without a deleted App's view; undefined when it was not pinned. */
export function withoutView(current: SidebarPins, appId: string): SidebarPins | undefined {
  const pins = without(current.pins, { kind: 'view', appId })
  return pins.length === current.pins.length ? undefined : { ...current, revision: current.revision + 1, pins }
}
