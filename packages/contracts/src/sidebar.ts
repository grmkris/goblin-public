import * as Schema from 'effect/Schema'
import { AppId, NonEmptyString } from './ids.ts'

/** A connection's id, as the MCP host names it. */
const ConnectionId = NonEmptyString(200)

/** The most pins the sidebar keeps, and the most servers it remembers having pinned on its own (ADR 0053). */
export const MAX_PINS = 40
export const MAX_SEEN = 200

/** What a pin opens: a whole server (its own App, in its own thread) or one App view (one note, one drawing). */
export const SidebarTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('server'), connectionId: ConnectionId }),
  Schema.Struct({ kind: Schema.Literal('view'), appId: AppId }),
])
export type SidebarTarget = typeof SidebarTarget.Type

/** One pinned row: a server, or an App view under the name it was pinned with. */
export const SidebarPin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('server'), connectionId: ConnectionId }),
  Schema.Struct({ kind: Schema.Literal('view'), appId: AppId, title: NonEmptyString(120) }),
])
export type SidebarPin = typeof SidebarPin.Type

/** The one key a pin and its target share: `server:<connection>` or `view:<app>`. */
export const pinKey = (target: SidebarTarget): string =>
  target.kind === 'server' ? `server:${target.connectionId}` : `view:${target.appId}`

/**
 * The owner's pinned servers and App views in their order, synced to every device (ADR 0053). `seen` names the servers
 * the sidebar has already pinned on its own once: a connected server with its own App shows pinned until the owner
 * changes the pins, and one the owner unpinned stays unpinned.
 */
export const SidebarPins = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pins: Schema.Array(SidebarPin).check(
    Schema.isMaxLength(MAX_PINS),
    Schema.makeFilter((pins) => new Set(pins.map(pinKey)).size === pins.length),
  ),
  seen: Schema.Array(ConnectionId).check(Schema.isMaxLength(MAX_SEEN)),
})
export type SidebarPins = typeof SidebarPins.Type
export const EMPTY_SIDEBAR: SidebarPins = { revision: 0, pins: [], seen: [] }

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_PINS))

/** Pin (at `index`, else last), unpin, or move a pin to `index`. Pinning what is pinned moves it. */
export const SidebarOperation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('pin'), pin: SidebarPin, index: Schema.optional(Index) }),
  Schema.Struct({ kind: Schema.Literal('unpin'), target: SidebarTarget }),
  Schema.Struct({ kind: Schema.Literal('move'), target: SidebarTarget, index: Index }),
])
export type SidebarOperation = typeof SidebarOperation.Type

/**
 * `POST /api/sidebar`: one change to the pins as they were at `expectedRevision`. `adopt` names the servers the
 * sidebar showed pinned on its own but had not stored yet: they are stored first, in that order, then `op` applies.
 */
export const SidebarEdit = Schema.Struct({
  expectedRevision: SidebarPins.fields.revision,
  adopt: Schema.optional(Schema.Array(ConnectionId).check(Schema.isMaxLength(MAX_PINS))),
  op: SidebarOperation,
})
export type SidebarEdit = typeof SidebarEdit.Type

/** The pins after the edit, or as they are when another device changed them first. */
export const SidebarEditResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('applied'), sidebar: SidebarPins }),
  Schema.Struct({ kind: Schema.Literal('stale'), sidebar: SidebarPins }),
])
export type SidebarEditResult = typeof SidebarEditResult.Type
