import {
  HomeEdit,
  HomeEditResult,
  type HomeLayout,
  type HomeRead,
  type HomeTile,
  type HomeOperation,
} from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { agentAppId, appPlacement } from '../apps/registry.ts'
import type { AgentApps } from '../agent-apps/engine.ts'
import { type AppError, Conflict, Forbidden, InvalidInput, NotFound, attemptSync } from '../http/errors.ts'
import { Changes } from '../runtime/changes.ts'
import { appHomeOperations } from '../storage/schema.ts'
import { applyHomeOperations, ownerTargets, touchedTiles } from './operations.ts'
import { homeLayout, readHome, writeHome } from './store.ts'

type Actor = HomeTile['placedBy']

/** An edit's stored receipt, as its replay and its Undo read it back. */
const storedResult = Schema.decodeUnknownSync(Schema.fromJsonString(HomeEditResult))

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** The Home layout changed: an edit applied, or an App's deletion took its tile (its new revision). */
    'home.changed': { readonly revision: number }
  }
}

/**
 * The owner's Home surface: its saved layout and the edits that arrange it. Placement changes presentation and never
 * touches grants or App state, and no network or Pi call happens inside a layout transaction.
 */
export class Home extends Context.Service<
  Home,
  {
    /** The layout and the agent apps that can be placed on it. */
    readonly read: Effect.Effect<HomeRead, AppError>
    readonly layout: Effect.Effect<HomeLayout, AppError>
    /** Whether an edit needs its MCP Apps checked against their servers first: not a replay, a stale edit or an Undo. */
    readonly needsAppVerification: (input: HomeEdit, actor: Actor) => Effect.Effect<boolean, AppError>
    /** One atomic ordered edit, or the owner's Undo of one: applied, stale, or waiting on the owner. */
    readonly edit: (input: HomeEdit, actor: Actor) => Effect.Effect<HomeEditResult, AppError>
    /** Announces the layout an App deletion already changed in its own transaction. */
    readonly appRemoved: Effect.Effect<void, AppError>
  }
>()('goblin/home/Home') {
  /** Home over `store`, the one per agent: an applied edit, and an App's deletion, tell `home.changed`. */
  static readonly make = (store: HomeService) =>
    Effect.gen(function* () {
      const changes = yield* Changes
      const changed = Effect.flatMap(
        attemptSync(() => store.layout()),
        (layout) => changes.publish('home.changed', { revision: layout.revision }),
      )
      return Home.of({
        read: attemptSync(() => store.read()).pipe(Effect.withSpan('Home.read')),
        layout: attemptSync(() => store.layout()).pipe(Effect.withSpan('Home.layout')),
        needsAppVerification: Effect.fn('Home.needsAppVerification')(function* (input: HomeEdit, actor: Actor) {
          return yield* attemptSync(() => store.needsAppVerification(input, actor))
        }),
        edit: Effect.fn('Home.edit')(function* (input: HomeEdit, actor: Actor) {
          const result = yield* attemptSync(() => store.edit(input, actor))
          if (result.kind === 'applied') yield* changed
          return result
        }),
        appRemoved: changed.pipe(Effect.withSpan('Home.appRemoved')),
      })
    })
}

/**
 * Owner-scoped application metadata, as rows: a store with no state of its own (the Home service tells the change
 * bus). No network or Pi calls occur in a layout transaction.
 */
export class HomeService<RunResult = unknown> {
  readonly #db: SQLiteAsyncDatabase<'sync', RunResult>
  constructor(
    db: SQLiteAsyncDatabase<'sync', RunResult>,
    readonly engine: AgentApps,
  ) {
    this.#db = db
  }
  layout(): HomeLayout {
    return readHome(this.#db)
  }
  read(): HomeRead {
    return {
      layout: this.layout(),
      apps: this.engine.store.apps().map((app) => ({
        name: app.name,
        id: agentAppId(this.#db, app.name),
        hasView: this.engine.info(app.name)?.ui ?? false,
      })),
    }
  }
  /** Replays and stale intent need no network pre-check. The transaction repeats both guards before writing. */
  needsAppVerification(input: HomeEdit, actor: Actor): boolean {
    const row = this.#db
      .select()
      .from(appHomeOperations)
      .where(eq(appHomeOperations.operationId, input.operationId))
      .get()
    if (row !== undefined && row.actor !== actor) throw new Conflict({ reason: 'operation belongs to another actor' })
    return row === undefined && this.layout().revision === input.expectedRevision && input.undoOf === undefined
  }
  edit(input: HomeEdit, actor: Actor): HomeEditResult {
    const valid = Schema.decodeSync(HomeEdit)(input)
    const result = this.#db.transaction((tx) => {
      const replay = tx
        .select()
        .from(appHomeOperations)
        .where(eq(appHomeOperations.operationId, valid.operationId))
        .get()
      if (replay !== undefined) {
        if (replay.actor !== actor) throw new Conflict({ reason: 'operation belongs to another actor' })
        return storedResult(replay.result)
      }
      const before = readHome(tx)
      if (before.revision !== valid.expectedRevision) return { kind: 'stale' as const, layout: before }
      const owned = actor === 'agent' ? ownerTargets(before, valid.ops) : []
      if (owned.length > 0) return { kind: 'owner-required' as const, layout: before, tileIds: owned }
      const layout =
        valid.undoOf === undefined ? applyHomeOperations(before, valid.ops, actor) : this.#undo(valid, before, actor)
      this.#validateApps(layout, valid, actor)
      const receipt: HomeEditResult = {
        kind: 'applied',
        operationId: valid.operationId,
        layout,
        tileIds: touchedTiles(valid.ops),
        message: this.#message(valid, layout),
      }
      writeHome(tx, layout)
      tx.insert(appHomeOperations)
        .values({
          operationId: valid.operationId,
          actor,
          result: JSON.stringify(receipt),
          before: JSON.stringify(before),
        })
        .run()
      return receipt
    })
    return result
  }
  #undo(input: HomeEdit, current: HomeLayout, actor: Actor): HomeLayout {
    if (actor !== 'owner') throw new Forbidden({ reason: 'only the owner can Undo a receipt' })
    const row = this.#db
      .select()
      .from(appHomeOperations)
      .where(eq(appHomeOperations.operationId, input.undoOf ?? ''))
      .get()
    if (row === undefined) throw new NotFound({ what: 'home receipt' })
    const result = storedResult(row.result)
    if (result.kind !== 'applied' || result.layout.revision !== current.revision)
      throw new Conflict({ reason: 'Home changed after this edit; Undo cannot overwrite a later edit' })
    return { revision: current.revision + 1, tiles: homeLayout(JSON.parse(row.before)).tiles }
  }
  #validateAdd(op: HomeOperation, actor: Actor): void {
    if (op.kind !== 'add' || op.tile.kind !== 'app') return
    const placement = appPlacement(this.#db, op.tile.appId)
    if (placement.source !== 'mcp') return
    if (actor !== 'owner') throw new InvalidInput({ reason: 'Only the owner pins MCP Apps on Home' })
    if (placement.closed) throw new InvalidInput({ reason: 'Open the MCP App before putting it on Home' })
  }
  #validateApps(layout: HomeLayout, input: HomeEdit, actor: Actor): void {
    for (const op of input.ops) this.#validateAdd(op, actor)
    const agentViews = new Set(
      this.read()
        .apps.filter((app) => app.hasView && app.id !== null)
        .map((app) => app.id),
    )
    for (const tile of layout.tiles) {
      if (tile.kind !== 'app') continue
      const placement = appPlacement(this.#db, tile.appId)
      if (placement.source === 'agent' && !agentViews.has(tile.appId))
        throw new InvalidInput({ reason: 'Home needs an existing agent app with a view' })
    }
  }
  #message(input: HomeEdit, layout: HomeLayout): string {
    if (input.undoOf !== undefined) return 'Undid the Home edit'
    const additions = input.ops.filter((op) => op.kind === 'add')
    if (additions.length === 1) {
      const tile = layout.tiles.find((candidate) => candidate.id === additions[0]?.tile.id)
      const title =
        tile?.kind === 'app'
          ? appPlacement(this.#db, tile.appId).title
          : tile?.kind === 'note'
            ? tile.title
            : 'Recent conversations'
      return `Placed ${title ?? 'a tile'} on Home`
    }
    return 'Updated Home'
  }
}
