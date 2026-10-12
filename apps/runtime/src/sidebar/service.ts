import { SidebarEdit, type SidebarEditResult, type SidebarPins } from '@goblin/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { type AppError, attemptSync } from '../http/errors.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { editedSidebar, readSidebar, withoutServer, withoutView, writeSidebar } from './store.ts'

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** The owner's sidebar pins changed (ADR 0053): an edit, or a removed server or deleted App took its pin. */
    'sidebar.changed': { readonly revision: number }
  }
}

/**
 * The owner's pinned servers and App views (ADR 0053): one revisioned row, synced to every device through the
 * workspace feed. Pinning changes presentation only: it grants nothing and opens no connection.
 */
export class Sidebar extends Context.Service<
  Sidebar,
  {
    readonly read: Effect.Effect<SidebarPins, AppError>
    /** One pin, unpin or move against the revision the browser read: applied, or stale with the pins as they are. */
    readonly edit: (edit: SidebarEdit) => Effect.Effect<SidebarEditResult, AppError>
    /** A connection was removed: its server's pin goes, and it is forgotten. */
    readonly forgetServer: (connectionId: string) => Effect.Effect<void, AppError>
    /** An App was deleted: its view's pin goes. */
    readonly forgetView: (appId: string) => Effect.Effect<void, AppError>
  }
>()('goblin/sidebar/Sidebar') {}

/** The sidebar over the agent's database: every write is one short transaction, then told to the change bus. */
export const sidebarOver = (db: Db['Service'], changes: Changes['Service']) => {
  const told = (sidebar: SidebarPins | undefined) =>
    sidebar === undefined ? Effect.void : changes.publish('sidebar.changed', { revision: sidebar.revision })
  /** Writes what `change` makes of the pins, when it changes them, inside one transaction. */
  const rewrite = (change: (current: SidebarPins) => SidebarPins | undefined) =>
    attemptSync(() =>
      db.transaction((tx) => {
        const next = change(readSidebar(tx))
        if (next !== undefined) writeSidebar(tx, next)
        return next
      }),
    )
  return Sidebar.of({
    read: attemptSync(() => readSidebar(db)).pipe(Effect.withSpan('Sidebar.read')),
    edit: Effect.fn('Sidebar.edit')(function* (input: SidebarEdit) {
      const edit = yield* attemptSync(() => Schema.decodeSync(SidebarEdit)(input))
      const result = yield* attemptSync((): SidebarEditResult =>
        db.transaction((tx) => {
          const current = readSidebar(tx)
          if (current.revision !== edit.expectedRevision) return { kind: 'stale', sidebar: current }
          const sidebar = editedSidebar(current, edit)
          writeSidebar(tx, sidebar)
          return { kind: 'applied', sidebar }
        }),
      )
      if (result.kind === 'applied') yield* told(result.sidebar)
      return result
    }),
    forgetServer: Effect.fn('Sidebar.forgetServer')(function* (connectionId: string) {
      yield* Effect.flatMap(
        rewrite((current) => withoutServer(current, connectionId)),
        told,
      )
    }),
    forgetView: Effect.fn('Sidebar.forgetView')(function* (appId: string) {
      yield* Effect.flatMap(
        rewrite((current) => withoutView(current, appId)),
        told,
      )
    }),
  })
}

/**
 * The owner's sidebar pins, over the agent's database. A removed connection (`mcp.removed`) and a deleted App
 * (`apps.removed`) take their pins with them, each written at once and told to the change bus.
 */
export const SidebarLive: Layer.Layer<Sidebar, never, Db | Changes> = Layer.effect(
  Sidebar,
  Effect.gen(function* () {
    const changes = yield* Changes
    const sidebar = sidebarOver(yield* Db, changes)
    yield* changes.on('mcp.removed', ({ connectionId }) => sidebar.forgetServer(connectionId))
    yield* changes.on('apps.removed', ({ id }) => sidebar.forgetView(id))
    return sidebar
  }),
)
